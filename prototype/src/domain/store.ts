import type {
  Bed, BedState, Clearance, Emergency, Fail, MigrationRow, Notification, Persona, Res, State, Staff, StayType,
} from './types'
import { buildSeed } from './seed'
import { DAY, HOUR, addDays, dateStr, fmtDate, fmtDateTime, nowMs, resetClock, today } from './time'
import {
  activeStayOfBed, activeStayOfStaff, bedAllocatable, bedById, bedConflict, can, deny, eligibility, hasRole, inScope, isPA, openReservationOfStaff,
  outOfScope, roomOf, selfAction, staffById, suggestBeds, type Perm,
} from './rules'

import {
  fail, fullName, bedCode, guard, log, notify, ok, openCleaning, reauth, registerTick, run, runTick, setBed, uid,
} from './core'
export { getState, resetState, useAppState } from './core'
import { commsActions } from './ext/comms'
import { accessActions } from './ext/access'
import { structureActions } from './ext/structures'
import { securityActions, contractorAccess } from './ext/security'
import { outageActions } from './ext/outage'

const base = {
  /* ---------------- requests & allocation ---------------- */
  submitRequest(actor: Persona, f: { staffId: string; arrival: string; end: string; stayType: StayType; note: string }) {
    return run<string>(d => {
      const staff = staffById(d, f.staffId)
      if (!staff) return fail('Staff record not found')
      const own = actor.staffId === f.staffId
      const e = guard(own ? null : deny(actor, 'request.submit', 'submit requests on behalf of staff'))
      if (e) return e
      if (!f.end) return fail('A planned end date is required for standard stays (D-54)', 'Requester', 'Enter the planned end date')
      if (f.end <= f.arrival) return fail('The departure date must be after the arrival date (D-103)')
      if (staff.status !== 'Active') return fail(`${staff.name} has left the organisation and can't request accommodation`, 'Accommodation Admin', 'Reactivate via authorised rehire first')
      if (activeStayOfStaff(d, staff.id) || openReservationOfStaff(d, staff.id)) return fail(`${staff.name} already has a stay or reservation`, 'Accommodation Admin', 'Use transfer or extension instead')
      if (d.requests.some(r => r.staffId === staff.id && (r.status === 'Submitted' || r.status === 'ChangesRequested'))) return fail(`${staff.name} already has an open request`, 'Accommodation Admin', 'Decide the existing request first')
      const id = uid(d, 'Q')
      d.requests.push({ id, staffId: staff.id, createdAt: nowMs(), arrival: f.arrival, end: f.end, stayType: f.stayType, note: f.note, status: 'Submitted', submittedBy: actor.staffId ?? actor.id, onBehalf: !own })
      log(d, actor, 'Request submitted', `${staff.name}, arrival ${fmtDate(f.arrival)}${own ? '' : ' (on behalf)'}`)
      notify(d, { toRole: 'AA', text: `New accommodation request: ${staff.name}, arriving ${fmtDate(f.arrival)}` })
      return ok('Request submitted. An Accommodation Admin will decide within 2 business days', id)
    })
  },

  /** D-44: approval selects the bed and creates the reservation in one atomic step. */
  approveRequest(actor: Persona, requestId: string, bedId: string, opts: { exceptionReason?: string } = {}) {
    return run<string>(d => {
      const q = d.requests.find(x => x.id === requestId)
      if (!q || q.status !== 'Submitted') return fail('This request is no longer open', 'System', 'Refresh the inbox')
      const bed = bedById(d, bedId)
      if (!bed) return fail('Bed not found')
      const staff = staffById(d, q.staffId)!
      const e = guard(deny(actor, 'request.approve', 'approve accommodation requests'), outOfScope(actor, bed.siteId), selfAction(actor, q.staffId, 'approve'))
      if (e) return e
      const held = bedAllocatable(d, bed)
      if (held) return held
      // revalidate at confirm time: the bed may have changed since it was selected (concurrency)
      const c = bedConflict(d, bed.id, { from: q.arrival, to: q.end })
      if (c) return c.kind === 'block' ? fail(`${bed.code} is blocked for those dates: ${c.who}`, 'Maintenance Coordinator', 'Pick another bed') : fail(`${bed.code} was just taken: ${c.who} holds it for overlapping dates`, 'Another admin', 'Pick the next suggested bed')
      let el = eligibility(d, staff, bed)
      if (!el.ok && opts.exceptionReason) {
        const g = guard(deny(actor, 'request.exception', 'approve eligibility exceptions'))
        if (g) return g
        staff.exceptions.push(el.reasons.some(r => r.includes('gender')) ? 'gender' : 'grade')
        q.exceptionBy = actor.name
        log(d, actor, 'Eligibility exception', `${staff.name} → ${bed.code}: ${opts.exceptionReason}`)
        el = eligibility(d, staff, bed)
      }
      if (!el.ok) return fail(el.reasons.join('; '), 'Policy Approver', 'Request an eligibility exception (reason + evidence required)')
      const rid = uid(d, 'R')
      d.reservations.push({ id: rid, bedId: bed.id, staffId: staff.id, from: q.arrival, to: q.end, eta: Date.parse(q.arrival + 'T14:00:00Z'), status: 'Reserved', createdAt: nowMs(), source: 'Request', requestId: q.id, stayType: q.stayType })
      q.status = 'Approved'; q.reservationId = rid; q.decision = { by: actor.name, at: nowMs() }
      log(d, actor, 'Request approved + reserved', `${staff.name} → ${bed.code} from ${fmtDate(q.arrival)}`)
      notify(d, { toStaffId: staff.id, text: `Your request is approved. Bed ${bed.code} is reserved from ${fmtDate(q.arrival)}.`, email: true })
      notify(d, { toRole: 'Rec', text: `Expect arrival: ${staff.name} on ${fmtDate(q.arrival)} → ${bed.code}` })
      return ok(`Approved. ${bed.code} reserved for ${staff.name}`, rid)
    })
  },
  rejectRequest(actor: Persona, requestId: string, reason: string) {
    return run(d => {
      const q = d.requests.find(x => x.id === requestId)
      if (!q || q.status !== 'Submitted') return fail('This request is no longer open')
      const e = guard(deny(actor, 'request.approve', 'reject requests'), selfAction(actor, q.staffId, 'reject'))
      if (e) return e
      if (!reason.trim()) return fail('A reason is required to reject', 'You', 'Enter the reason')
      q.status = 'Rejected'; q.decision = { by: actor.name, at: nowMs(), reason }
      log(d, actor, 'Request rejected', `${fullName(d, q.staffId)}: ${reason}`)
      notify(d, { toStaffId: q.staffId, text: `Your accommodation request was not approved: ${reason}`, email: true })
      return ok('Request rejected')
    })
  },
  cancelRequest(actor: Persona, requestId: string) {
    return run(d => {
      const q = d.requests.find(x => x.id === requestId)
      if (!q || (q.status !== 'Submitted' && q.status !== 'ChangesRequested')) return fail('Only open requests can be cancelled')
      if (actor.staffId !== q.staffId && !can(actor, 'request.approve')) return fail('Only the requester or an admin can cancel')
      q.status = 'Cancelled'; log(d, actor, 'Request cancelled', fullName(d, q.staffId))
      return ok('Request cancelled')
    })
  },
  waitlistRequest(actor: Persona, requestId: string) {
    return run(d => {
      const q = d.requests.find(x => x.id === requestId)
      if (!q || q.status !== 'Submitted') return fail('This request is no longer open')
      const e = guard(deny(actor, 'waitlist.manage', 'manage the waitlist'), selfAction(actor, q.staffId, 'waitlist'))
      if (e) return e
      const staff = staffById(d, q.staffId)!
      const now = nowMs()
      d.waitlist.push({ id: uid(d, 'W'), staffId: staff.id, requestId: q.id, createdAt: now, queueTs: now, expiresAt: now + d.config.waitlistDays * DAY, priority: 'Standard', declines: 0, skipBeds: [], status: 'Waiting', remindersSent: [], gender: staff.gender })
      q.status = 'Waitlisted'; q.decision = { by: actor.name, at: now }
      log(d, actor, 'Waitlisted', `${staff.name} valid ${d.config.waitlistDays} days`)
      notify(d, { toStaffId: staff.id, text: `No bed is free yet. You're on the waitlist for ${d.config.waitlistDays} days.`, email: true })
      return ok(`${staff.name} added to the waitlist for ${d.config.waitlistDays} days`)
    })
  },

  /** Bulk allocation: each row is atomic and retry-safe; failed rows leave no trace. */
  bulkAllocate(actor: Persona, rows: { staffId: string; bedId: string; from: string; to: string; stayType: StayType }[]) {
    return run<{ staffId: string; ok: boolean; msg: string }[]>(d => {
      const e = guard(deny(actor, 'allocate.bulk', 'run bulk allocation'))
      if (e) return e
      const out = rows.map(r => {
        const staff = staffById(d, r.staffId)!
        const bed = bedById(d, r.bedId)
        if (!bed) return { staffId: r.staffId, ok: false, msg: 'Bed not found' }
        if (d.reservations.some(x => x.staffId === r.staffId && x.bedId === r.bedId && x.status === 'Reserved')) return { staffId: r.staffId, ok: true, msg: 'Already allocated (skipped, retry-safe)' }
        const g = guard(outOfScope(actor, bed.siteId), selfAction(actor, r.staffId, 'allocate a bed for'), bedAllocatable(d, bed))
        if (g) return { staffId: r.staffId, ok: false, msg: g.reason }
        if (activeStayOfStaff(d, r.staffId) || openReservationOfStaff(d, r.staffId)) return { staffId: r.staffId, ok: false, msg: 'Already has a stay or reservation' }
        const c = bedConflict(d, bed.id, { from: r.from, to: r.to })
        if (c) return { staffId: r.staffId, ok: false, msg: `${bed.code} taken by ${c.who}` }
        const el = eligibility(d, staff, bed)
        if (!el.ok) return { staffId: r.staffId, ok: false, msg: el.reasons.join('; ') }
        d.reservations.push({ id: uid(d, 'R'), bedId: bed.id, staffId: staff.id, from: r.from, to: r.to, eta: Date.parse(r.from + 'T14:00:00Z'), status: 'Reserved', createdAt: nowMs(), source: 'Bulk', stayType: r.stayType })
        return { staffId: r.staffId, ok: true, msg: `Reserved ${bed.code}` }
      })
      log(d, actor, 'Bulk allocation', `${out.filter(x => x.ok).length} of ${out.length} rows succeeded`)
      return ok(`${out.filter(x => x.ok).length} of ${out.length} allocated`, out)
    })
  },

  /* ---------------- check-in / checkout ---------------- */
  checkIn(actor: Persona, reservationId: string, f: { idVerified: boolean; keyIssued: boolean }) {
    return run(d => {
      const r = d.reservations.find(x => x.id === reservationId)
      if (!r || r.status !== 'Reserved') return fail('This reservation is no longer active', 'System', 'Refresh the list')
      const bed = bedById(d, r.bedId)!, staff = staffById(d, r.staffId)!
      const e = guard(deny(actor, 'checkin.execute', 'check residents in'), outOfScope(actor, bed.siteId), selfAction(actor, r.staffId, 'check in'))
      if (e) return e
      if (!f.idVerified) return fail('Identity must be verified before check-in', 'Reception', 'Verify the resident’s ID and photo')
      if (!f.keyIssued) return fail('Issue the room key to complete check-in', 'Reception', 'Record the key handover')
      if (r.from > today()) return fail(`Arrival is ${fmtDate(r.from)}, not today`, 'Reception', 'Check in on the arrival date')
      if (staff.status !== 'Active') return fail(`${staff.name} is no longer active`, 'Accommodation Admin', 'Cancel the reservation')
      if (bed.state !== 'Available') {
        const why = bed.state === 'NeedsCleaning' ? 'needs cleaning' : bed.state === 'InspectionRequired' ? 'is awaiting final inspection' : bed.state === 'Occupied' ? 'is still occupied' : `is ${bed.state}`
        return fail(`${bed.code} ${why}`, bed.state === 'InspectionRequired' ? 'Final Inspection holder' : 'Housekeeping', bed.state === 'NeedsCleaning' ? 'Assign cleaning, then run final inspection' : 'Complete readiness')
      }
      const el = eligibility(d, staff, bed)
      if (!el.ok) return fail('Eligibility changed since reservation: ' + el.reasons.join('; '), 'Policy Approver', 'Review the exception or reallocate')
      const sid = uid(d, 'S')
      d.stays.push({ id: sid, bedId: bed.id, staffId: staff.id, start: today(), end: r.to, status: 'Active', source: 'Standard', stayType: r.stayType })
      setBed(d, bed, 'Occupied'); r.status = 'CheckedIn'
      d.keys.push({ id: uid(d, 'K'), bedId: bed.id, staffId: staff.id, kind: 'Room key', status: 'Issued', at: nowMs() })
      log(d, actor, 'Check-in', `${staff.name} → ${bed.code} (stay + bed occupancy committed together)`)
      notify(d, { toStaffId: staff.id, text: `Welcome. You're checked in to ${bed.code}.`, email: true })
      return ok(`${staff.name} checked in to ${bed.code}`)
    })
  },
  bulkCheckIn(actor: Persona, ids: string[]) {
    return run<{ id: string; ok: boolean; msg: string }[]>(d => {
      const e = guard(deny(actor, 'checkin.execute', 'check residents in'))
      if (e) return e
      const out = ids.map(id => {
        const r = d.reservations.find(x => x.id === id)
        if (!r || r.status !== 'Reserved') return { id, ok: false, msg: 'Not an active reservation' }
        const bed = bedById(d, r.bedId)!, staff = staffById(d, r.staffId)!
        const g = guard(selfAction(actor, staff.id, 'check in'))
        if (g) return { id, ok: false, msg: g.reason }
        if (r.from > today()) return { id, ok: false, msg: `${staff.name}: arrives ${fmtDate(r.from)}` }
        if (bed.state !== 'Available') return { id, ok: false, msg: `${staff.name}: ${bed.code} not ready (${bed.state})` }
        if (!eligibility(d, staff, bed).ok) return { id, ok: false, msg: `${staff.name}: eligibility changed` }
        d.stays.push({ id: uid(d, 'S'), bedId: bed.id, staffId: staff.id, start: today(), end: r.to, status: 'Active', source: 'Standard', stayType: r.stayType })
        setBed(d, bed, 'Occupied'); r.status = 'CheckedIn'
        d.keys.push({ id: uid(d, 'K'), bedId: bed.id, staffId: staff.id, kind: 'Room key', status: 'Issued', at: nowMs() })
        return { id, ok: true, msg: `${staff.name} → ${bed.code}` }
      })
      log(d, actor, 'Bulk check-in', `${out.filter(x => x.ok).length} of ${out.length} checked in`)
      return ok(`${out.filter(x => x.ok).length} of ${out.length} checked in`, out)
    })
  },
  extendNoShow(actor: Persona, reservationId: string, reason: string) {
    return run(d => {
      const r = d.reservations.find(x => x.id === reservationId)
      if (!r || r.status !== 'Reserved') return fail('Reservation is not active')
      const e = guard(deny(actor, 'request.approve', 'extend a no-show'), selfAction(actor, r.staffId, 'extend'))
      if (e) return e
      if (r.noShowExtended) return fail('A no-show can be extended only once', 'Accommodation Admin', 'Cancel the reservation or check in')
      if (!reason.trim()) return fail('A reason is required', 'You', 'Enter the reason')
      r.eta += d.config.noShowHours * HOUR; r.noShowExtended = true
      log(d, actor, 'No-show extended', `${fullName(d, r.staffId)}: ${reason}`)
      return ok('Reservation extended once by 24 hours')
    })
  },
  cancelReservation(actor: Persona, reservationId: string, reason: string) {
    return run(d => {
      const r = d.reservations.find(x => x.id === reservationId)
      if (!r || r.status !== 'Reserved') return fail('Reservation is not active')
      const e = guard(deny(actor, 'request.approve', 'cancel reservations'))
      if (e) return e
      if (!reason.trim()) return fail('A reason is required', 'You', 'Enter the reason')
      r.status = 'Cancelled'; log(d, actor, 'Reservation cancelled', `${fullName(d, r.staffId)} → ${bedCode(d, r.bedId)}: ${reason}`)
      return ok('Reservation cancelled')
    })
  },
  requestCheckout(actor: Persona, stayId: string) {
    return run(d => {
      const st = d.stays.find(x => x.id === stayId)
      if (!st || st.status !== 'Active') return fail('No active stay')
      if (actor.staffId !== st.staffId) return fail('Only the resident can request checkout')
      st.checkoutRequested = true; st.checkoutRequestedAt = nowMs()
      log(d, actor, 'Checkout requested', `${fullName(d, st.staffId)} · ${bedCode(d, st.bedId)}`)
      notify(d, { toRole: 'Rec', text: `${fullName(d, st.staffId)} requested checkout from ${bedCode(d, st.bedId)}. Acknowledge within 1 business day.` })
      return ok('Checkout requested. Reception will confirm within 1 business day')
    })
  },
  /** Checkout ≠ clearance complete ≠ bed ready (D-64). */
  checkout(actor: Persona, stayId: string, f: { keysReturned: boolean }) {
    return run(d => {
      const st = d.stays.find(x => x.id === stayId)
      if (!st || st.status !== 'Active') return fail('No active stay')
      const bed = bedById(d, st.bedId)!
      const e = guard(deny(actor, 'checkout.execute', 'process checkouts'), outOfScope(actor, bed.siteId), selfAction(actor, st.staffId, 'check out'))
      if (e) return e
      if (d.emergencies.some(x => x.stayId === st.id && x.status === 'Pending')) return fail('A provisional stay needs a decision before checkout', 'Emergency approver', 'Decide the emergency check-in first')
      st.status = 'Ended'; st.checkedOutAt = nowMs(); st.checkoutRequested = false
      d.keys.filter(k => k.bedId === bed.id && k.staffId === st.staffId && k.status === 'Issued').forEach(k => { if (f.keysReturned) k.status = 'Returned' })
      setBed(d, bed, 'NeedsCleaning'); openCleaning(d, bed.id)
      const cl = d.clearances.find(c => c.stayId === st.id && c.status === 'Open')
      if (cl) {
        const k = cl.items.find(i => i.id === 'k')
        if (k && f.keysReturned) k.status = 'Done'
      }
      log(d, actor, 'Checkout', `${fullName(d, st.staffId)} left ${bed.code}. Bed → Needs cleaning (not Available)`)
      return ok(`Checked out. ${bed.code} is now Needs cleaning`)
    })
  },

  /* ---------------- waitlist & offers ---------------- */
  makeOffer(actor: Persona, entryId: string, bedId: string) {
    return run(d => {
      const en = d.waitlist.find(x => x.id === entryId)
      const bed = bedById(d, bedId)
      if (!en || en.status !== 'Waiting') return fail('Waitlist entry is not waiting', 'System', 'Refresh')
      if (!bed) return fail('Bed not found')
      const e = guard(deny(actor, 'offer.manage', 'make bed offers'), outOfScope(actor, bed.siteId))
      if (e) return e
      const staff = staffById(d, en.staffId)!
      if (d.offers.some(o => o.staffId === staff.id && o.status === 'Pending')) return fail(`${staff.name} already has an active offer (one at a time)`, 'Resident', 'Wait for the response')
      const h = bedAllocatable(d, bed)
      if (h) return h
      if (en.skipBeds.includes(bed.id)) return fail(`${staff.name} already declined ${bed.code}`, 'Accommodation Admin', 'Offer a different bed')
      if (bed.state !== 'Available') return fail(`${bed.code} is ${bed.state === 'Occupied' ? 'occupied' : 'not ready'}`, 'Housekeeping', 'Offer a bed that is Available')
      const el = eligibility(d, staff, bed)
      if (!el.ok) return fail(el.reasons.join('; '), 'Policy Approver', 'Offer an eligible bed')
      if (bedConflict(d, bed.id, { from: today() })) return fail(`${bed.code} has a reservation or stay`, 'Accommodation Admin', 'Pick a free bed')
      const id = uid(d, 'O')
      d.offers.push({ id, entryId: en.id, staffId: staff.id, bedId: bed.id, createdAt: nowMs(), status: 'Pending' })
      bed.heldBy = id; en.status = 'Offered'
      log(d, actor, 'Bed offered', `${staff.name} ← ${bed.code}`)
      notify(d, { toStaffId: staff.id, text: `A bed is offered to you (${bed.code}). Accept or decline within ${d.config.offerHours} hours of reading this.`, email: true, ref: { kind: 'offer', id } })
      return ok(`Offer sent. ${bed.code} is held for ${staff.name}. The 48h timer starts on confirmed delivery`)
    })
  },
  /** D-51: the clock starts on confirmed delivery (viewed in-app, email confirmed) or documented offline follow-up. */
  deliverOffer(actor: Persona, offerId: string, via: 'viewed' | 'email' | 'offline') {
    return run(d => {
      const o = d.offers.find(x => x.id === offerId)
      if (!o || o.status !== 'Pending') return fail('Offer is no longer pending')
      if (o.deliveredAt) return ok('Already delivered')
      if (via === 'offline') { const e = guard(deny(actor, 'offer.manage', 'record offline delivery')); if (e) return e }
      const now = nowMs()
      o.deliveredAt = now; o.deliveredVia = via; o.expiresAt = now + d.config.offerHours * HOUR
      log(d, actor, 'Offer delivered', `${fullName(d, o.staffId)} · ${via === 'offline' ? 'informed offline by staff' : via === 'viewed' ? 'viewed in app' : 'email confirmed'} · 48h clock started`)
      return ok('Delivery confirmed. 48-hour window started')
    })
  },
  acceptOffer(actor: Persona, offerId: string, onBehalf = false) {
    return run(d => {
      const o = d.offers.find(x => x.id === offerId)
      if (!o || o.status !== 'Pending') return fail('Offer is no longer pending', 'System', 'Refresh')
      const own = actor.staffId === o.staffId
      if (!own) {
        const e = guard(deny(actor, 'offer.manage', 'accept on a resident’s behalf'))
        if (e) return e
        if (!onBehalf) return fail('Record the resident’s consent to accept on their behalf', 'Reception', 'Tick the consent box')
      }
      const bed = bedById(d, o.bedId)!, staff = staffById(d, o.staffId)!
      const now = nowMs()
      if (o.expiresAt && now > o.expiresAt) return fail('This offer has expired', 'System', 'Ask the Accommodation Admin to re-offer')
      if (!o.deliveredAt) { o.deliveredAt = now; o.deliveredVia = own ? 'viewed' : 'offline'; o.expiresAt = now + d.config.offerHours * HOUR }
      const el = eligibility(d, staff, bed)
      if (!el.ok) return fail('Eligibility changed: ' + el.reasons.join('; '), 'Policy Approver', 'Review')
      const en = d.waitlist.find(x => x.id === o.entryId)!
      const q = d.requests.find(x => x.id === en.requestId)
      const from = today() > (q?.arrival ?? today()) ? today() : (q?.arrival ?? today())
      const to = q?.end ?? addDays(today(), 180)
      const rid = uid(d, 'R')
      d.reservations.push({ id: rid, bedId: bed.id, staffId: staff.id, from, to, eta: Date.parse(from + 'T14:00:00Z') + (from === today() ? 0 : 0), status: 'Reserved', createdAt: now, source: 'Offer', stayType: q?.stayType ?? 'Permanent' })
      o.status = 'Accepted'; o.acceptedBy = actor.name; o.acceptedOnBehalf = !own
      delete bed.heldBy
      en.status = 'Closed'; en.closeReason = 'Allocated'
      if (q) { q.status = 'Approved'; q.reservationId = rid }
      log(d, actor, 'Offer accepted', `${staff.name} → ${bed.code}${own ? '' : ' (on behalf, consent recorded)'}`)
      notify(d, { toRole: 'Rec', text: `${staff.name} accepted ${bed.code}. Expect arrival ${fmtDate(from)}.` })
      return ok(`Offer accepted. ${bed.code} is reserved`)
    })
  },
  declineOffer(actor: Persona, offerId: string) {
    return run(d => {
      const o = d.offers.find(x => x.id === offerId)
      if (!o || o.status !== 'Pending') return fail('Offer is no longer pending')
      if (actor.staffId !== o.staffId) { const e = guard(deny(actor, 'offer.manage', 'decline for a resident')); if (e) return e }
      const bed = bedById(d, o.bedId)!, en = d.waitlist.find(x => x.id === o.entryId)!
      o.status = 'Declined'; delete bed.heldBy
      en.declines += 1; en.skipBeds.push(bed.id); en.status = 'Waiting'
      let msg = 'Offer declined. Your queue position is kept (first decline)'
      if (en.declines >= 2) { en.queueTs = nowMs(); en.declines = 0; en.skipBeds = []; msg = 'Offer declined. This was the second decline, so the entry moves to the back of the eligible queue' }
      log(d, actor, 'Offer declined', `${fullName(d, o.staffId)} · ${bed.code} · ${msg}`)
      return ok(msg)
    })
  },
  renewWaitlist(actor: Persona, entryId: string) {
    return run(d => {
      const en = d.waitlist.find(x => x.id === entryId)
      if (!en) return fail('Entry not found')
      const e = guard(deny(actor, 'waitlist.manage', 'renew waitlist entries'))
      if (e) return e
      const staff = staffById(d, en.staffId)!
      if (staff.status !== 'Active') return fail('Eligibility revalidation failed: staff has left', 'Accommodation Admin', 'Close the entry')
      const now = nowMs()
      const expired = en.status === 'Closed'
      en.expiresAt = (expired ? now : en.expiresAt) + d.config.waitlistDays * DAY
      if (expired) { en.status = 'Waiting'; en.queueTs = now; en.closeReason = undefined; en.remindersSent = [] }
      log(d, actor, 'Waitlist renewed', `${staff.name} ${expired ? '(after expiry: position reset)' : '(position kept)'}`)
      return ok(expired ? 'Renewed after expiry. Position reset to the back of the queue' : 'Renewed. Queue position kept')
    })
  },
  closeWaitlist(actor: Persona, entryId: string, reason: string) {
    return run(d => {
      const en = d.waitlist.find(x => x.id === entryId)
      if (!en) return fail('Entry not found')
      const e = guard(deny(actor, 'waitlist.manage', 'close waitlist entries'))
      if (e) return e
      en.status = 'Closed'; en.closeReason = reason
      return ok('Waitlist entry closed')
    })
  },

  /* ---------------- transfers, swaps, extensions ---------------- */
  requestTransfer(actor: Persona, f: { stayId: string; destBedId: string; reason: string }) {
    return run(d => {
      const st = d.stays.find(x => x.id === f.stayId)
      if (!st || st.status !== 'Active') return fail('No active stay')
      if (actor.staffId !== st.staffId) { const e = guard(deny(actor, 'transfer.request', 'request transfers')); if (e) return e }
      if (!f.destBedId) return fail('Choose a destination bed')
      if (d.transfers.some(t => t.stayId === st.id && ['Submitted', 'Approved'].includes(t.status))) return fail('There is already an open transfer for this stay')
      const id = uid(d, 'T')
      d.transfers.push({ id, kind: 'Transfer', stayId: st.id, destBedId: f.destBedId, reason: f.reason, requestedBy: actor.staffId ?? actor.id, createdAt: nowMs(), status: 'Submitted' })
      notify(d, { toRole: 'AA', text: `Transfer request: ${fullName(d, st.staffId)} to ${bedCode(d, f.destBedId)}` })
      return ok('Transfer requested', id)
    })
  },
  requestSwap(actor: Persona, f: { stayId: string; otherStayId: string; reason: string }) {
    return run(d => {
      const a = d.stays.find(x => x.id === f.stayId), b = d.stays.find(x => x.id === f.otherStayId)
      if (!a || !b || a.status !== 'Active' || b.status !== 'Active') return fail('Both beds must be occupied for a swap')
      if (a.id === b.id) return fail('Choose two different residents')
      const e = guard(deny(actor, 'transfer.request', 'request swaps'))
      if (e) return e
      d.transfers.push({ id: uid(d, 'T'), kind: 'Swap', stayId: a.id, otherStayId: b.id, reason: f.reason, requestedBy: actor.staffId ?? actor.id, createdAt: nowMs(), status: 'Submitted' })
      return ok('Swap requested')
    })
  },
  decideTransfer(actor: Persona, id: string, approve: boolean, reason: string) {
    return run(d => {
      const t = d.transfers.find(x => x.id === id)
      if (!t || t.status !== 'Submitted') return fail('This transfer is no longer open')
      const st = d.stays.find(x => x.id === t.stayId)!
      const other = t.otherStayId ? d.stays.find(x => x.id === t.otherStayId) : undefined
      const e = guard(deny(actor, 'transfer.approve', 'decide transfers'), selfAction(actor, st.staffId, 'approve'), selfAction(actor, other?.staffId ?? '', 'approve'),
        actor.staffId === t.requestedBy ? fail('You can’t approve a request you raised', 'Separation of duties (D-26)', 'Routed to an independent approver') : null)
      if (e) return e
      if (!approve && !reason.trim()) return fail('A reason is required to reject', 'You', 'Enter the reason')
      t.status = approve ? 'Approved' : 'Rejected'; t.decidedBy = actor.name; t.note = reason || undefined
      log(d, actor, `${t.kind} ${approve ? 'approved' : 'rejected'}`, `${fullName(d, st.staffId)}${other ? ' ⇄ ' + fullName(d, other.staffId) : ' → ' + bedCode(d, t.destBedId ?? '')}`)
      return ok(`${t.kind} ${approve ? 'approved. Reception can execute it' : 'rejected'}`)
    })
  },
  /** D-61/D-62: lock the destination before releasing the source; atomic; on failure the resident stays put. */
  executeTransfer(actor: Persona, id: string, opts: { injectFailure?: boolean } = {}) {
    const attempt = run(d => {
      const t = d.transfers.find(x => x.id === id)
      if (!t || t.status !== 'Approved') return fail('Only approved transfers can be executed', 'Accommodation Admin', 'Approve first (approval ≠ execution)')
      const st = d.stays.find(x => x.id === t.stayId)!
      const e = guard(deny(actor, 'transfer.execute', 'execute transfers'), selfAction(actor, st.staffId, 'execute'))
      if (e) return e
      const staff = staffById(d, st.staffId)!
      if (t.kind === 'Transfer') {
        const dest = bedById(d, t.destBedId)!, src = bedById(d, st.bedId)!
        // 1) lock/validate destination first
        const h = bedAllocatable(d, dest); if (h) return h
        if (dest.state !== 'Available') return fail(`${dest.code} is ${dest.state === 'Occupied' ? 'occupied' : 'not ready'}`, 'Housekeeping', 'Pick another destination')
        const c = bedConflict(d, dest.id, { from: today(), to: st.end }); if (c) return fail(`${dest.code} was just taken: ${c.who}`, 'Another admin', 'Pick another destination')
        const el = eligibility(d, staff, dest); if (!el.ok) return fail(el.reasons.join('; '), 'Policy Approver', 'Pick an eligible bed')
        setBed(d, dest, 'Occupied')
        // 2) release the source
        setBed(d, src, 'NeedsCleaning'); openCleaning(d, src.id)
        st.bedId = dest.id
        // 3) key return/reissue
        d.keys.filter(k => k.bedId === src.id && k.staffId === staff.id && k.status === 'Issued').forEach(k => { k.status = 'Returned' })
        if (opts.injectFailure) return fail('Key reissue failed after the source was released. Everything was rolled back', 'System', 'Retry the transfer')
        d.keys.push({ id: uid(d, 'K'), bedId: dest.id, staffId: staff.id, kind: 'Room key', status: 'Issued', at: nowMs() })
        t.status = 'Executed'
        log(d, actor, 'Transfer executed', `${staff.name}: ${src.code} → ${dest.code}`)
        return ok(`${staff.name} moved from ${src.code} to ${dest.code}`)
      }
      const other = d.stays.find(x => x.id === t.otherStayId)!
      const otherStaff = staffById(d, other.staffId)!
      const ba = bedById(d, st.bedId)!, bb = bedById(d, other.bedId)!
      const g = guard(selfAction(actor, other.staffId, 'execute'))
      if (g) return g
      const e1 = eligibility(d, staff, bb), e2 = eligibility(d, otherStaff, ba)
      if (!e1.ok) return fail(`${staff.name} can't move to ${bb.code}: ${e1.reasons.join('; ')}`, 'Policy Approver', 'Request an exception or reject the swap')
      if (!e2.ok) return fail(`${otherStaff.name} can't move to ${ba.code}: ${e2.reasons.join('; ')}`, 'Policy Approver', 'Request an exception or reject the swap')
      st.bedId = bb.id; other.bedId = ba.id
      d.keys.filter(k => k.status === 'Issued' && (k.staffId === staff.id || k.staffId === otherStaff.id)).forEach(k => { k.status = 'Returned' })
      d.keys.push({ id: uid(d, 'K'), bedId: bb.id, staffId: staff.id, kind: 'Room key', status: 'Issued', at: nowMs() }, { id: uid(d, 'K'), bedId: ba.id, staffId: otherStaff.id, kind: 'Room key', status: 'Issued', at: nowMs() })
      if (opts.injectFailure) return fail('Key reissue failed mid-swap. Both residents stay in their original beds', 'System', 'Retry the swap')
      t.status = 'Executed'
      log(d, actor, 'Swap executed', `${staff.name} ⇄ ${otherStaff.name} (${ba.code} ⇄ ${bb.code}) as one atomic operation`)
      return ok(`${staff.name} and ${otherStaff.name} swapped beds`)
    })
    if (!attempt.ok) {
      // record the failure on the transfer; the resident has not moved
      run(d => { const t = d.transfers.find(x => x.id === id); if (t && t.status === 'Approved') { t.status = 'Failed'; t.note = attempt.reason }; return ok() })
    }
    return attempt
  },
  requestExtension(actor: Persona, f: { stayId: string; newEnd: string; reason: string }) {
    return run<string>(d => {
      const st = d.stays.find(x => x.id === f.stayId)
      if (!st || st.status !== 'Active') return fail('No active stay')
      if (actor.staffId !== st.staffId) { const e = guard(deny(actor, 'extension.request', 'request extensions')); if (e) return e }
      if (st.end && f.newEnd <= st.end) return fail('The new end date must be after the current end date')
      const days = st.end ? Math.round((Date.parse(f.newEnd) - Date.parse(st.end)) / DAY) : 0
      const id = uid(d, 'X')
      d.extensions.push({ id, stayId: st.id, newEnd: f.newEnd, reason: f.reason, createdAt: nowMs(), requestedBy: actor.staffId ?? actor.id, status: 'Submitted', beyondPolicy: days > d.config.extensionPolicyDays })
      return ok(days > d.config.extensionPolicyDays ? 'Extension requested. It goes to the Policy Approver (beyond policy)' : 'Extension requested', id)
    })
  },
  decideExtension(actor: Persona, id: string, approve: boolean, reason: string) {
    return run(d => {
      const x = d.extensions.find(e => e.id === id)
      if (!x || x.status !== 'Submitted') return fail('Already decided')
      const st = d.stays.find(s => s.id === x.stayId)!
      const e = guard(deny(actor, x.beyondPolicy ? 'extension.beyond' : 'extension.approve', x.beyondPolicy ? 'approve beyond-policy extensions (Policy Approver)' : 'approve extensions'),
        selfAction(actor, st.staffId, 'approve'), actor.staffId === x.requestedBy ? fail('You can’t approve a request you raised', 'Separation of duties (D-26)', 'Routed to an independent approver') : null)
      if (e) return e
      if (approve) {
        const c = bedConflict(d, st.bedId, { from: addDays(st.end ?? today(), 1), to: x.newEnd }, { stayId: st.id })
        if (c) return fail(`The next booking on this bed (${c.who}) clashes with the new end date`, 'Accommodation Admin', 'Offer a transfer instead of rejecting')
        st.end = x.newEnd
      } else if (!reason.trim()) return fail('A reason is required to reject', 'You', 'Enter the reason')
      x.status = approve ? 'Approved' : 'Rejected'; x.decidedBy = actor.name; x.note = reason
      log(d, actor, `Extension ${approve ? 'approved' : 'rejected'}`, `${fullName(d, st.staffId)} → ${fmtDate(x.newEnd)}`)
      return ok(`Extension ${approve ? 'approved' : 'rejected'}`)
    })
  },

  /* ---------------- exit, clearance, housekeeping ---------------- */
  markLeft(actor: Persona, staffId: string, f: { effective: string; reason: string; confirm: boolean }) {
    return run<string>(d => {
      const staff = staffById(d, staffId)
      if (!staff) return fail('Staff not found')
      const stay = activeStayOfStaff(d, staffId)
      const bed = stay ? bedById(d, stay.bedId) : undefined
      const e = guard(deny(actor, 'exit.markLeft', 'mark staff as Left'), bed ? outOfScope(actor, bed.siteId) : null, selfAction(actor, staffId, 'mark as Left'), reauth(f.confirm, 'mark as Left'))
      if (e) return e
      if (staff.status === 'Left') return fail(`${staff.name} is already marked as Left`)
      if (!f.reason.trim()) return fail('A reason is required', 'You', 'Enter the reason')
      staff.status = 'Left'; staff.loginActive = false; staff.leftAt = nowMs(); staff.leftEffective = f.effective
      // D-36 side effects
      d.waitlist.filter(w => w.staffId === staffId && w.status !== 'Closed').forEach(w => { w.status = 'Closed'; w.closeReason = 'Staff left' })
      d.offers.filter(o => o.staffId === staffId && o.status === 'Pending').forEach(o => { o.status = 'Expired'; const b = bedById(d, o.bedId); if (b) delete b.heldBy })
      d.reservations.filter(r => r.staffId === staffId && r.status === 'Reserved').forEach(r => { r.status = 'Cancelled' })
      d.requests.filter(r => r.staffId === staffId && r.status === 'Submitted').forEach(r => { r.status = 'Cancelled' })
      d.emergencies.filter(m => m.staffId === staffId && m.status === 'Pending').forEach(m => { m.status = 'Rejected'; m.decisionReason = 'Converted into clearance case (staff left)'; m.decidedBy = 'System' })
      let msg = `${staff.name} marked as Left. Login revoked now`
      let cid: string | undefined
      if (stay) {
        cid = uid(d, 'C'); stay.exitPending = true
        d.clearances.push({
          id: cid, staffId, stayId: stay.id, openedAt: nowMs(), effective: f.effective, reason: f.reason, status: 'Open',
          items: [
            { id: 'k', label: 'Room and locker keys returned', mandatory: true, owner: 'Reception', status: 'Open' },
            { id: 'a', label: 'Assets returned (TV remote, linen)', mandatory: true, owner: 'Reception', status: 'Open' },
            { id: 'i', label: 'Room inspection and damage/loss record', mandatory: true, owner: 'Maintenance', status: 'Open' },
            { id: 'm', label: 'Open maintenance issues resolved', mandatory: false, owner: 'Maintenance', status: 'Open' },
          ],
        })
        msg += `. ${bed!.code} stays Occupied until actual checkout`
      }
      log(d, actor, 'Marked as Left', `${staff.name} · effective ${fmtDate(f.effective)} · ${f.reason}`)
      notify(d, { toRole: 'PA', text: `${staff.name} marked as Left (${f.reason}).` })
      return ok(msg, cid)
    })
  },
  setClearanceItem(actor: Persona, caseId: string, itemId: string, done: boolean) {
    return run(d => {
      const c = d.clearances.find(x => x.id === caseId)
      if (!c || c.status !== 'Open') return fail('Case is closed')
      const it = c.items.find(x => x.id === itemId)!
      const e = guard(deny(actor, 'clearance.task', 'update clearance tasks'))
      if (e) return e
      if (it.owner === 'Maintenance' && hasRole(actor, 'Rec') && !hasRole(actor, 'MC')) return fail('Inspection items are owned by Maintenance', 'Maintenance Coordinator', 'Ask Maintenance to complete this item')
      it.status = done ? 'Done' : 'Open'
      log(d, actor, 'Clearance item', `${fullName(d, c.staffId)} · ${it.label} → ${it.status}${actor.staffId !== c.staffId ? ' (on resident’s behalf)' : ''}`)
      return ok(done ? 'Item completed' : 'Item reopened')
    })
  },
  waiveClearance(actor: Persona, caseId: string, reason: string, evidence: string) {
    return run(d => {
      const c = d.clearances.find(x => x.id === caseId)
      if (!c || c.status !== 'Open') return fail('Case is closed')
      const e = guard(deny(actor, 'clearance.waive', 'waive clearance items (Policy Approver only)'))
      if (e) return e
      if (!reason.trim() || !evidence.trim()) return fail('Reason and evidence are both required', 'You', 'Complete both fields')
      c.items.filter(i => i.mandatory && i.status === 'Open').forEach(i => { i.status = 'Waived' })
      c.waiver = { by: actor.name, reason, evidence }
      log(d, actor, 'Clearance waiver', `${fullName(d, c.staffId)}: ${reason}`)
      return ok('Mandatory items waived. The case can now be closed')
    })
  },
  closeClearance(actor: Persona, caseId: string) {
    return run(d => {
      const c = d.clearances.find(x => x.id === caseId)
      if (!c || c.status !== 'Open') return fail('Case is already closed')
      const e = guard(deny(actor, 'exit.markLeft', 'close clearance cases'))
      if (e) return e
      const open = c.items.filter(i => i.mandatory && i.status === 'Open')
      if (open.length) return fail(`${open.length} mandatory item${open.length > 1 ? 's' : ''} unresolved: ${open.map(i => i.label).join('; ')}`, open[0].owner, 'Complete the items, or request a waiver from the Policy Approver')
      const st = c.stayId ? d.stays.find(x => x.id === c.stayId) : undefined
      if (st && st.status === 'Active') return fail('The resident still occupies the bed', 'Reception', 'Process checkout first, then close clearance')
      c.status = 'Closed'; log(d, actor, 'Clearance closed', fullName(d, c.staffId))
      return ok('Clearance case closed')
    })
  },
  assignCleaning(actor: Persona, taskId: string, staffId: string) {
    return run(d => {
      const t = d.cleaning.find(x => x.id === taskId)
      if (!t || t.status !== 'Open') return fail('Task is not open')
      const e = guard(deny(actor, 'housekeeping.assign', 'assign cleaning'))
      if (e) return e
      const bed = bedById(d, t.bedId)!
      const own = activeStayOfStaff(d, staffId)
      if (own && roomOf(d, bedById(d, own.bedId)!).id === bed.roomId) return fail('A cleaner can’t be assigned their own room', 'Separation of duties (D-26)', 'Choose another housekeeper')
      t.assignedTo = staffId
      log(d, actor, 'Cleaning assigned', `${bed.code} → ${fullName(d, staffId)}`)
      return ok('Cleaning assigned')
    })
  },
  completeCleaning(actor: Persona, taskId: string) {
    return run(d => {
      const t = d.cleaning.find(x => x.id === taskId)
      if (!t || t.status !== 'Open') return fail('Task is not open')
      const e = guard(deny(actor, 'housekeeping.clean', 'complete cleaning (Housekeeping capability)'))
      if (e) return e
      const bed = bedById(d, t.bedId)!
      const own = actor.staffId ? activeStayOfStaff(d, actor.staffId) : undefined
      if (own && roomOf(d, bedById(d, own.bedId)!).id === bed.roomId) return fail('You can’t clean your own room', 'Separation of duties (D-26)', 'Ask Reception to reassign')
      t.status = 'Cleaned'; t.cleanedBy = actor.staffId
      setBed(d, bed, 'InspectionRequired')
      log(d, actor, 'Cleaning done', `${bed.code} → Inspection required`)
      return ok(`${bed.code} cleaned. It's not Available until final inspection`)
    })
  },
  finalInspection(actor: Persona, bedId: string, pass: boolean) {
    return run(d => {
      const bed = bedById(d, bedId)!
      const e = guard(deny(actor, 'inspect.final', 'run final inspection (Final Inspection capability)'), outOfScope(actor, bed.siteId))
      if (e) return e
      if (bed.state !== 'InspectionRequired') return fail(`${bed.code} is not awaiting inspection`)
      const t = [...d.cleaning].reverse().find(x => x.bedId === bed.id && x.status === 'Cleaned')
      if (t && t.cleanedBy && t.cleanedBy === actor.staffId) return fail('You cleaned this room, so you can’t inspect it', 'Separation of duties (D-26)', 'Ask another inspector')
      if (pass) { setBed(d, bed, 'Available'); if (t) t.status = 'Passed'; log(d, actor, 'Final inspection passed', `${bed.code} → Available`); return ok(`${bed.code} is Available`) }
      setBed(d, bed, 'NeedsCleaning'); openCleaning(d, bed.id); log(d, actor, 'Final inspection failed', `${bed.code} → Needs cleaning`)
      return ok(`${bed.code} failed inspection and goes back to cleaning`)
    })
  },

  /* ---------------- inventory ---------------- */
  blockBed(actor: Persona, bedId: string, reason: string) {
    return run(d => {
      const bed = bedById(d, bedId)!
      const e = guard(deny(actor, 'bed.block', 'block beds'), outOfScope(actor, bed.siteId))
      if (e) return e
      if (!reason.trim()) return fail('A reason is required', 'You', 'Enter the reason')
      if (bed.state === 'Occupied') return fail(`${bed.code} is occupied. Existing residents are flagged, never auto-moved`, 'Accommodation Admin', 'Transfer or check out the resident first')
      setBed(d, bed, 'Blocked', reason)
      const future = d.reservations.filter(r => r.bedId === bed.id && r.status === 'Reserved')
      if (future.length) notify(d, { toRole: 'AA', text: `${bed.code} was blocked. ${future.length} future reservation(s) need reallocation.` })
      log(d, actor, 'Bed blocked', `${bed.code}: ${reason}`)
      return ok(future.length ? `${bed.code} blocked. ${future.length} future reservation flagged for reallocation` : `${bed.code} blocked`)
    })
  },
  unblockBed(actor: Persona, bedId: string) {
    return run(d => {
      const bed = bedById(d, bedId)!
      const e = guard(deny(actor, 'bed.block', 'unblock beds'), outOfScope(actor, bed.siteId))
      if (e) return e
      setBed(d, bed, 'NeedsCleaning'); openCleaning(d, bed.id)
      log(d, actor, 'Bed unblocked', `${bed.code} → Needs cleaning`)
      return ok(`${bed.code} unblocked. It needs cleaning and inspection before it's Available`)
    })
  },
  archiveBed(actor: Persona, bedId: string) {
    return run(d => {
      const bed = bedById(d, bedId)!
      const e = guard(deny(actor, 'bed.manage', 'archive beds'), outOfScope(actor, bed.siteId))
      if (e) return e
      const why: string[] = []
      if (bed.state === 'Occupied') why.push('it is occupied')
      if (d.reservations.some(r => r.bedId === bed.id && r.status === 'Reserved')) why.push('it has reservations')
      if (d.keys.some(k => k.bedId === bed.id && k.status === 'Issued')) why.push('keys are still issued')
      if (d.workOrders.some(w => w.bedId === bed.id && w.status !== 'Verified')) why.push('work orders are open')
      if (why.length) return fail(`${bed.code} can't be archived: ${why.join(', ')}`, 'Accommodation Admin', 'Resolve these first. Archiving never deletes history')
      setBed(d, bed, 'Archived'); log(d, actor, 'Bed archived', bed.code)
      return ok(`${bed.code} archived (history retained)`)
    })
  },
  addRoom(actor: Persona, f: { siteId: string; buildingId?: string; name: string; gender: 'Male' | 'Female' | 'Any'; beds: number }) {
    return run(d => {
      const e = guard(deny(actor, 'bed.manage', 'create rooms and beds'), outOfScope(actor, f.siteId))
      if (e) return e
      if (!f.name.trim()) return fail('Room name is required')
      const site = d.sites.find(s => s.id === f.siteId)!
      const rid = `${f.buildingId ?? site.id}-${f.name.replace(/\s+/g, '')}-${d.seq}`
      d.rooms.push({ id: rid, siteId: site.id, buildingId: f.buildingId || undefined, name: f.name, gender: f.gender })
      for (let i = 0; i < Math.min(f.beds, 8); i++) { const L = 'ABCDEFGH'[i]; d.beds.push({ id: `${rid}-${L}`, code: `${f.buildingId ?? site.code}-${f.name.replace(/\s+/g, '')}-${L}`, roomId: rid, siteId: site.id, state: 'Available' }) }
      log(d, actor, 'Room created', `${f.name} with ${f.beds} bed(s) in ${site.name}`)
      return ok(`${f.name} created with ${f.beds} bed(s)`)
    })
  },
  addBuilding(actor: Persona, f: { siteId: string; name: string }) {
    return run(d => {
      const e = guard(deny(actor, 'building.create', 'create buildings (Super Admin, or an Accommodation Admin with the Building Creation capability)'), outOfScope(actor, f.siteId))
      if (e) return e
      if (!f.name.trim()) return fail('Building name is required')
      d.buildings.push({ id: `${f.siteId}-${f.name.replace(/\s+/g, '')}`, siteId: f.siteId, name: f.name })
      log(d, actor, 'Building created', `${f.name} in ${f.siteId}`)
      return ok(`${f.name} created`)
    })
  },
  addSite(actor: Persona, f: { name: string; kind: 'Villa' | 'Apartment' }) {
    return run(d => {
      const e = guard(deny(actor, 'site.create', 'create sites (Super Admin only)'))
      if (e) return e
      if (!f.name.trim()) return fail('Site name is required')
      const code = f.name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 3)
      d.sites.push({ id: code + d.seq, code, name: f.name, kind: f.kind, minGrade: 1 })
      log(d, actor, 'Site created', f.name)
      return ok(`${f.name} created`)
    })
  },

  /* ---------------- emergency check-in ---------------- */
  createEmergency(actor: Persona, f: { staffId: string; bedId: string; reason: string; confirm: boolean }) {
    return run(d => {
      const bed = bedById(d, f.bedId), staff = staffById(d, f.staffId)
      if (!bed || !staff) return fail('Choose a person and a bed')
      const e = guard(deny(actor, 'emergency.initiate', 'initiate emergency check-ins (needs the Emergency Check-in capability)'), outOfScope(actor, bed.siteId), selfAction(actor, f.staffId, 'initiate an emergency check-in for'), reauth(f.confirm, 'initiate an emergency check-in'))
      if (e) return e
      if (!f.reason.trim()) return fail('A reason is required', 'You', 'Describe the emergency')
      if (activeStayOfStaff(d, staff.id)) return fail(`${staff.name} already has a stay`)
      if (bed.state !== 'Available') return fail(`${bed.code} is ${bed.state}`, 'Housekeeping', 'Choose a bed that is Available')
      const c = bedConflict(d, bed.id, { from: today(), to: addDays(today(), 3) }); if (c) return fail(`${bed.code} is reserved by ${c.who}`, 'Accommodation Admin', 'Pick a free bed')
      const sid = uid(d, 'S'), eid = uid(d, 'EM')
      d.stays.push({ id: sid, bedId: bed.id, staffId: staff.id, start: today(), status: 'Active', source: 'Provisional', stayType: 'Contract', endPending: true, emergencyId: eid })
      setBed(d, bed, 'Occupied')
      const approverRole: 'AA' | 'PA' = hasRole(actor, 'AA') ? 'PA' : 'AA'
      d.emergencies.push({ id: eid, stayId: sid, staffId: staff.id, bedId: bed.id, initiatorId: actor.id, initiatorRole: actor.role, approverRole, reason: f.reason, createdAt: nowMs(), status: 'Pending', reminders: 0, escalation: 0 })
      log(d, actor, 'Emergency check-in', `${staff.name} → ${bed.code} (provisional): ${f.reason}`)
      notify(d, { toRole: approverRole === 'AA' ? 'AA' : 'PA', text: `Emergency check-in needs your decision within ${d.config.emergencyDeadlineHours}h: ${staff.name} → ${bed.code}` })
      return ok(`${staff.name} is in ${bed.code} as a provisional stay. Decision due within 24h`)
    })
  },
  decideEmergency(actor: Persona, id: string, approve: boolean, reason: string) {
    return run(d => {
      const m = d.emergencies.find(x => x.id === id)
      if (!m || m.status !== 'Pending') return fail('Already decided')
      if (actor.id === m.initiatorId || (actor.staffId && actor.staffId === m.staffId)) return fail('You can’t decide an emergency you initiated or are part of', 'Separation of duties (D-26)', 'The approver route is independent of the initiator')
      let allowed: boolean
      if (m.escalation === 0) allowed = m.approverRole === 'AA' ? can(actor, 'emergency.approve') || isPA(actor) : isPA(actor)
      else if (m.escalation === 1) allowed = can(actor, 'emergency.backup') || isPA(actor)
      else allowed = isPA(actor) || hasRole(actor, 'SA')
      if (!allowed) {
        const who = m.escalation === 0 ? (m.approverRole === 'AA' ? 'an Accommodation Admin' : 'the Policy Approver') : m.escalation === 1 ? 'the backup approver or Policy Approver' : 'the Policy Approver or a Super Admin'
        return fail(`${actor.name} isn't on the current approval route`, who, `Currently routed to ${who}`)
      }
      if (!approve && !reason.trim()) return fail('A reason is required to reject', 'You', 'Enter the reason')
      const st = d.stays.find(x => x.id === m.stayId)!
      m.status = approve ? 'Approved' : 'Rejected'; m.decidedBy = actor.name; m.decisionReason = reason; m.decidedAt = nowMs()
      if (approve) { st.source = 'Standard'; st.endPending = true } else {
        d.tasks.push({ id: uid(d, 'TK'), title: `Relocate or check out ${fullName(d, m.staffId)} from ${bedCode(d, m.bedId)}`, ownerRole: 'AA', due: nowMs() + d.config.emergencyRelocationHours * HOUR, done: false, ref: m.id })
      }
      log(d, actor, `Emergency ${approve ? 'approved' : 'rejected'}`, `${fullName(d, m.staffId)} · ${bedCode(d, m.bedId)}${reason ? ': ' + reason : ''}`)
      return ok(approve ? 'Emergency check-in approved. Assign an end date within 30 days' : 'Rejected. A relocation task is open for the Accommodation Admin. The resident is not moved automatically')
    })
  },
  completeTask(actor: Persona, taskId: string) {
    return run(d => { const t = d.tasks.find(x => x.id === taskId); if (t) t.done = true; return ok('Task done') })
  },

  /* ---------------- staff, CSV, migration ---------------- */
  addStaff(actor: Persona, f: Omit<Staff, 'status' | 'loginActive' | 'exceptions' | 'verified' | 'source'>) {
    return run<string>(d => {
      const e = guard(deny(actor, 'staff.manage', 'create staff records'))
      if (e) return e
      const key = f.id.trim().toLowerCase()
      if (!key) return fail('Employee ID is required')
      const dup = d.staff.find(s => s.id.trim().toLowerCase() === key)
      if (dup) return fail(`Employee ID ${dup.id} already belongs to ${dup.name}`, 'Accommodation Admin', 'Duplicates are rejected, never auto-merged. Open the existing profile')
      if (!f.name.trim()) return fail('Full name is required')
      d.staff.push({ ...f, id: f.id.trim(), status: 'Active', loginActive: true, exceptions: [], verified: false, source: 'Manual' })
      log(d, actor, 'Staff created', `${f.name} (${f.id.trim()}) · username defaults to employee ID`)
      return ok(`${f.name} added. Username ${f.id.trim()}${f.email ? ', invitation link sent' : ', temporary credential via approved offline hand-over'}`, f.id.trim())
    })
  },
  commitStaffCsv(actor: Persona, rows: Omit<Staff, 'status' | 'loginActive' | 'exceptions' | 'verified' | 'source'>[]) {
    return run(d => {
      const e = guard(deny(actor, 'staff.manage', 'import staff'))
      if (e) return e
      let n = 0
      for (const r of rows) {
        if (d.staff.some(s => s.id.toLowerCase() === r.id.toLowerCase())) continue
        d.staff.push({ ...r, status: 'Active', loginActive: true, exceptions: [], verified: false, source: 'CSV' }); n++
      }
      log(d, actor, 'CSV import committed', `${n} staff created`)
      return ok(`${n} staff imported. They are unverified until reviewed`)
    })
  },
  verifyStaff(actor: Persona, id: string) {
    return run(d => {
      const e = guard(deny(actor, 'staff.manage', 'verify staff'))
      if (e) return e
      const s = staffById(d, id); if (!s) return fail('Not found')
      s.verified = true; log(d, actor, 'Staff verified', s.name)
      return ok(`${s.name} verified`)
    })
  },
  updateOwnContact(actor: Persona, f: { phone: string; emergencyContact: string }) {
    return run(d => {
      const s = staffById(d, actor.staffId)
      if (!s) return fail('No staff record')
      s.phone = f.phone; s.emergencyContact = f.emergencyContact
      log(d, actor, 'Contact updated', s.name)
      return ok('Contact details updated. Other fields are managed by the Accommodation Admin')
    })
  },
  prepareMigration(actor: Persona, rows: MigrationRow[]) {
    return run(d => {
      const e = guard(deny(actor, 'migration.prepare', 'prepare a migration import (maker)'))
      if (e) return e
      d.migration = { id: uid(d, 'MG'), preparedBy: actor.name, rows, status: 'Prepared' }
      log(d, actor, 'Migration prepared', `${rows.filter(r => !r.error).length} valid rows awaiting sign-off`)
      return ok('Prepared. A Policy Approver or Super Admin must sign off (maker-checker)')
    })
  },
  signOffMigration(actor: Persona) {
    return run(d => {
      const m = d.migration
      if (!m || m.status !== 'Prepared') return fail('Nothing to sign off')
      const e = guard(deny(actor, 'migration.signoff', 'sign off a migration import (checker)'))
      if (e) return e
      if (m.preparedBy === actor.name) return fail('The maker can’t be the checker', 'Separation of duties (D-26)', 'A Policy Approver or Super Admin signs off')
      let n = 0
      for (const r of m.rows.filter(x => !x.error)) {
        const bed = d.beds.find(b => b.code === r.bedCode)!, staff = d.staff.find(s => s.id.toLowerCase() === r.empId.toLowerCase())!
        d.stays.push({ id: uid(d, 'S'), bedId: bed.id, staffId: staff.id, start: r.start, end: r.end, status: 'Active', source: 'Migrated', stayType: 'Permanent', endPending: !r.end })
        setBed(d, bed, 'Occupied'); d.keys.push({ id: uid(d, 'K'), bedId: bed.id, staffId: staff.id, kind: 'Room key', status: 'Issued', at: nowMs() }); n++
      }
      m.status = 'Imported'; m.signedBy = actor.name
      log(d, actor, 'Migration imported', `${n} stays tagged source = Migrated, bypassing request/reservation`)
      return ok(`${n} current occupancy records imported as Migrated stays`)
    })
  },

  /* ---------------- incidents, work orders, keys ---------------- */
  raiseSOS(actor: Persona, text: string, kind: 'SOS' | 'Incident' = 'SOS') {
    return run(d => {
      d.incidents.unshift({ id: uid(d, 'I'), kind, staffId: actor.staffId, text, at: nowMs() })
      log(d, actor, kind === 'SOS' ? 'SOS raised' : 'Incident reported', text)
      notify(d, { toRole: 'Sec', text: `${kind}: ${text}`, ...(kind === 'SOS' ? { email: true, critical: true } : {}) })
      return ok(kind === 'SOS' ? 'SOS sent to on-duty Security and the emergency contact. Call the front desk if you can' : 'Incident reported')
    })
  },
  ackIncident(actor: Persona, id: string) {
    return run(d => {
      const e = guard(deny(actor, 'incident.ack', 'acknowledge SOS'))
      if (e) return e
      const i = d.incidents.find(x => x.id === id); if (!i) return fail('Not found')
      i.ackAt = nowMs(); i.ackBy = actor.staffId ?? actor.name
      return ok('Acknowledged. Respond on site')
    })
  },
  closeIncident(actor: Persona, id: string) {
    return run(d => {
      const e = guard(deny(actor, 'incident.ack', 'close incidents'))
      if (e) return e
      const i = d.incidents.find(x => x.id === id); if (!i) return fail('Not found')
      if (!i.ackAt) return fail('Acknowledge before closing', 'Security', 'Acknowledge first')
      i.closed = true; return ok('Incident closed')
    })
  },
  createWorkOrder(actor: Persona, f: { bedId: string; title: string }) {
    return run(d => {
      const e = guard(deny(actor, 'workorder.create', 'create work orders'))
      if (e) return e
      if (!f.title.trim()) return fail('Describe the problem')
      d.workOrders.unshift({ id: uid(d, 'WO'), bedId: f.bedId, title: f.title, status: 'Open', createdAt: nowMs() })
      return ok('Work order created. Maintenance triage within 1 business day')
    })
  },
  advanceWorkOrder(actor: Persona, id: string, to: 'In progress' | 'Resolved' | 'Verified', assignee?: string) {
    return run(d => {
      const w = d.workOrders.find(x => x.id === id); if (!w) return fail('Not found')
      if (hasRole(actor, 'Vend')) {
        // a contractor works only on their own vendor's jobs, inside contract + documents + job + visit window (D-76)
        if (w.assignee !== actor.vendor) return fail('Not found')
        const why = contractorAccess(d, actor.vendor ?? '', w.id, nowMs())
        if (why) return fail(`Access not valid: ${why}`, 'Maintenance Coordinator', 'Ask for a gate pass and a visit window')
      }
      if (to === 'In progress') {
        const e = guard(can(actor, 'workorder.manage') || can(actor, 'workorder.work') ? null : deny(actor, 'workorder.manage', 'assign work'))
        if (e) return e
        w.status = 'In progress'; if (assignee) w.assignee = assignee
      } else if (to === 'Resolved') {
        const e = guard(deny(actor, 'workorder.work', 'resolve work'))
        if (e) return e
        w.status = 'Resolved'; w.resolvedBy = actor.staffId ?? actor.name
      } else {
        const e = guard(deny(actor, 'workorder.verify', 'verify work'))
        if (e) return e
        if (w.resolvedBy && (w.resolvedBy === actor.staffId || w.resolvedBy === actor.name)) return fail('You can’t verify your own work', 'Separation of duties (D-26)', 'An independent verifier signs off')
        w.status = 'Verified'
      }
      return ok(`Work order → ${w.status}`)
    })
  },
  reportKeyLost(actor: Persona, keyId: string) {
    return run(d => {
      const e = guard(deny(actor, 'key.manage', 'update keys'))
      if (e) return e
      const k = d.keys.find(x => x.id === keyId)!; k.status = 'Lost'
      log(d, actor, 'Key lost', `${bedCode(d, k.bedId)} · ${fullName(d, k.staffId)}`)
      return ok('Marked lost. A lost key is never marked returned')
    })
  },
  replaceKey(actor: Persona, keyId: string) {
    return run(d => {
      const e = guard(deny(actor, 'key.manage', 'issue keys'))
      if (e) return e
      const k = d.keys.find(x => x.id === keyId)!
      if (k.status !== 'Lost') return fail('Only a lost key is replaced')
      d.keys.push({ id: uid(d, 'K'), bedId: k.bedId, staffId: k.staffId, kind: k.kind, status: 'Issued', at: nowMs() })
      k.status = 'Lost'
      return ok('Replacement issued and linked. The old key stays retired as Lost')
    })
  },
  returnKey(actor: Persona, keyId: string) {
    return run(d => {
      const e = guard(deny(actor, 'key.manage', 'return keys'))
      if (e) return e
      const k = d.keys.find(x => x.id === keyId)!
      if (k.status === 'Lost') return fail('A lost key can’t be marked returned', 'Accommodation Admin', 'Issue a replacement instead')
      k.status = 'Returned'; return ok('Key returned')
    })
  },
  setDelegation(actor: Persona, f: { to: string; fromDate: string; toDate: string }) {
    return run(d => {
      const e = guard(deny(actor, 'delegate.set', 'set a delegate'))
      if (e) return e
      d.delegations = d.delegations.filter(x => x.from !== actor.name)
      d.delegations.push({ from: actor.name, to: f.to, fromDate: f.fromDate, toDate: f.toDate })
      log(d, actor, 'Delegation set', `${actor.name} → ${f.to}, ${f.fromDate} to ${f.toDate}`)
      return ok('Delegate recorded and audited')
    })
  },
  updateConfig(actor: Persona, patch: Partial<State['config']>) {
    return run(d => {
      const e = guard(deny(actor, 'config.edit', 'change configuration'))
      if (e) return e
      d.config = { ...d.config, ...patch }
      log(d, actor, 'Configuration changed', Object.keys(patch).join(', '))
      return ok('Configuration saved')
    })
  },

  /* ---------------- time-driven processing: reminds and escalates, never decides ---------------- */
  tick() { runTick() },
}


/* ---- core time-driven rules (waitlist, offers, reservations, emergencies) ---- */
registerTick(({ d, now, note, touch }) => {
    // waitlist reminders + expiry (D-47)
    for (const w of d.waitlist) {
      if (w.status === 'Closed') continue
      for (const day of d.config.waitlistReminderDays) {
        if (!w.remindersSent.includes(day) && now >= w.expiresAt - day * DAY && now < w.expiresAt) {
          w.remindersSent.push(day); note({ toStaffId: w.staffId, text: `Your waitlist entry expires in ${day} day${day > 1 ? 's' : ''}. Ask the Accommodation Admin to renew it.`, email: true })
        }
      }
      if (w.status === 'Waiting' && now >= w.expiresAt) {
        w.status = 'Closed'; w.closeReason = 'Expired'; touch()
        note({ toStaffId: w.staffId, text: 'Your waitlist entry expired. Ask to renew it to rejoin the queue.', email: true })
        log(d, 'System', 'Waitlist expired', fullName(d, w.staffId))
      }
    }
    // offers: 24h not viewed → Reception follow-up (D-52); 48h window expiry (D-49)
    for (const o of d.offers) {
      if (o.status !== 'Pending') continue
      if (!o.deliveredAt && !o.followUp && now >= o.createdAt + d.config.offerFollowUpHours * HOUR) {
        o.followUp = true; note({ toRole: 'Rec', text: `${fullName(d, o.staffId)} hasn't viewed the offer for ${bedCode(d, o.bedId)} in 24h. Please inform them in person or by phone and record it.` })
      }
      if (o.expiresAt && now >= o.expiresAt) {
        o.status = 'Expired'; const b = bedById(d, o.bedId); if (b) delete b.heldBy
        const en = d.waitlist.find(x => x.id === o.entryId); if (en && en.status === 'Offered') en.status = 'Waiting'
        log(d, 'System', 'Offer expired', `${fullName(d, o.staffId)} · ${bedCode(d, o.bedId)} · bed released, resident not removed from waitlist`)
        note({ toRole: 'AA', text: `Offer to ${fullName(d, o.staffId)} for ${bedCode(d, o.bedId)} expired unanswered.` })
        touch()
      }
    }
    // reservation expiry 24h after planned arrival (D-58)
    for (const r of d.reservations) {
      if (r.status === 'Reserved' && now > r.eta + d.config.noShowHours * HOUR) {
        r.status = 'Expired'; touch(); log(d, 'System', 'Reservation expired (no-show)', `${fullName(d, r.staffId)} · ${bedCode(d, r.bedId)}`)
        note({ toRole: 'AA', text: `${fullName(d, r.staffId)} didn't arrive. Reservation for ${bedCode(d, r.bedId)} expired.` })
      }
    }
    // emergency: re-alert every 24h, escalate after two unanswered (D-67). Never auto-approve, never auto-checkout.
    for (const m of d.emergencies) {
      if (m.status !== 'Pending') continue
      const due = Math.floor((now - m.createdAt) / (d.config.emergencyDeadlineHours * HOUR))
      while (m.reminders < due) {
        m.reminders++
        note({ toRole: m.escalation === 0 && m.approverRole === 'AA' ? 'AA' : 'PA', email: true, critical: true, text: `Reminder ${m.reminders}: emergency check-in for ${fullName(d, m.staffId)} still needs a decision.` })
        if (m.reminders >= d.config.emergencyEscalateAfter && m.escalation < 1) { m.escalation = 1; note({ toRole: 'PA', email: true, critical: true, text: `Escalated to backup approver: emergency check-in for ${fullName(d, m.staffId)} unanswered after ${m.reminders} reminders.` }) }
        else if (m.reminders > d.config.emergencyEscalateAfter) { m.escalation = 2; note({ toRole: 'PA', email: true, critical: true, text: `Escalated to Policy Approver / Super Admin: emergency check-in for ${fullName(d, m.staffId)} (critical).` }) }
        log(d, 'System', 'Emergency reminder', `${fullName(d, m.staffId)} · reminder ${m.reminders} · level ${m.escalation}`)
      }
    }
})

export const A = { ...base, ...commsActions, ...accessActions, ...structureActions, ...securityActions, ...outageActions }

export { suggestBeds, inScope, dateStr, fmtDateTime }
