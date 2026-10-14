/**
 * AT-038: separation of duties (D-26), one table for the whole system.
 *
 * Every action that decides, approves, allocates, processes, inspects, cleans, verifies, waives or initiates something about a person or a
 * thing is listed below. For each row the person it is about (and, where there is one, the person who raised it) tries it and is refused with
 * `separation_of_duties` (the documented code where it is another one), NOTHING changes (a fingerprint of the rows involved is identical before
 * and after, and no audit row appears except the refusal that is recorded on purpose for emergency decisions), and an independent person
 * of the same role then succeeds with the same call.
 *
 * A gap found while writing this table was closed in the command and is named in the row: the Policy Approver who ASKED for an exception
 * no longer decides it (grantException / declineException).
 *
 * The waitlist priority decision needs a global setting and lives in sod-priority.test.ts (a private database).
 */
import { afterAll, describe, expect, it } from 'vitest'
import { admin, closeAll, PASSWORD } from '../harness'
import { mkRequest, mkStaff } from '../fixtures3'
import * as RQ from '../requests/helpers'
import * as ST from '../stays/helpers'
import * as EM from '../emergency/helpers'
import * as XT from '../exit/helpers'
import * as KY from '../keys/helpers'
import * as RD from '../readiness/helpers'
import * as WL from '../waitlist/helpers'
import { fail, type Result } from '@/server/command/result'
import { rcFor } from '../rc'
import { approveRequest } from '@/server/commands/requests/approve'
import { rejectRequest, requestChanges } from '@/server/commands/requests/decide'
import { declineException, grantException, requestException } from '@/server/commands/requests/exceptions'
import { cancelReservation, extendNoShow } from '@/server/commands/allocation-admin/reservations'
import { confirmBulkAllocation, previewBulkAllocation } from '@/server/commands/allocation-admin/bulk'
import { addToWaitlist } from '@/server/commands/waitlist/add'
import { createOffer, offerToNext } from '@/server/commands/waitlist/offer'
import { confirmDelivery } from '@/server/commands/waitlist/delivery'
import { acceptOfferOnBehalf } from '@/server/commands/waitlist/respond'
import { renewEntry } from '@/server/commands/waitlist/renew'
import { checkIn } from '@/server/commands/stays/checkIn'
import { acknowledgeCheckout, processCheckout, requestCheckout } from '@/server/commands/stays/checkout'
import { approveTransfer, rejectTransfer } from '@/server/commands/stays/decideTransfer'
import { executeTransfer } from '@/server/commands/stays/executeTransfer'
import { requestTransfer } from '@/server/commands/stays/requestTransfer'
import { approveExtension, rejectExtension, requestExtension } from '@/server/commands/stays/extension'
import { initiateEmergency } from '@/server/commands/emergency/initiate'
import { approveEmergency, rejectEmergency } from '@/server/commands/emergency/decide'
import { completeTask } from '@/server/commands/emergency/completeTask'
import { markLeft } from '@/server/commands/exit/markLeft'
import { previewBulkExit } from '@/server/commands/exit/bulk'
import { completeItem, markOutstanding, reopenItem, waiveItem } from '@/server/commands/exit/items'
import { closeCase } from '@/server/commands/exit/close'
import { reactivateStaff } from '@/server/commands/exit/rehire'
import { issueItem, returnItem, markLost, markDamaged, foundItem, retireItem, replaceItem } from '@/server/commands/keys/movements'
import { assignCleaning } from '@/server/commands/readiness/assign'
import { completeCleaning } from '@/server/commands/readiness/clean'
import { failInspection, passInspection } from '@/server/commands/readiness/inspect'
import { decideRoleChange } from '@/server/commands/access/decide-role-change'
import { requestRoleChange } from '@/server/commands/access/request-role-change'
import { decideGrant } from '@/server/commands/access/decide-grant'
import { requestGrant } from '@/server/commands/access/request-grant'
import { resetPassword } from '@/server/commands/access/reset-password'
import { deactivateAccount } from '@/server/commands/access/deactivate-account'
import { revokeUserSessions } from '@/server/commands/access/revoke-sessions'
import { updateStaff } from '@/server/commands/staff/update'
import { archiveStaff } from '@/server/commands/staff/archive'
import { createDelegation } from '@/server/commands/approvals/delegation'
import { grantCapability, makeUser } from '../harness'

afterAll(closeAll)

type Code = 'separation_of_duties' | 'invalid' | 'not_found' | 'forbidden' | 'conflict'
interface Other { label: string; run: () => Promise<Result<unknown>>; code?: Code }
interface Arr {
  subject: () => Promise<Result<unknown>>
  others?: Other[]
  independent: () => Promise<Result<unknown>>
  fingerprint: () => Promise<string>
  /** Ids whose audit rows are counted before and after a refusal. */
  entities: string[]
  subjectCode?: Code
  /** Audit actions a refusal writes ON PURPOSE (the refusal itself is evidence: emergency decisions, AT-017). */
  refusalAudit?: string[]
}

const q = async (sql: string, args: unknown[] = []) => (await admin().query(sql, args)).rows
const fp = async (...qs: [string, unknown[]][]) => JSON.stringify(await Promise.all(qs.map(([s, a]) => q(s, a))))
const auditRows = async (ids: string[]) => ids.length ? (await q(`SELECT seq, action FROM audit_event WHERE entity_id = ANY($1::uuid[]) ORDER BY seq`, [ids])) as { seq: string; action: string }[] : []

/* ---------------- requests and allocation ---------------- */

async function requestScene() {
  const s = await RQ.scenario({ beds: 4 })
  const subject = await RQ.who('AA', { siteIds: [s.siteId] })
  const raiser = await RQ.who('AA', { siteIds: [s.siteId] })
  const independent = await RQ.who('AA', { siteIds: [s.siteId] })
  const requestId = await mkRequest({ staffId: subject.staffId, siteId: s.siteId, arrival: RQ.day(10), end: RQ.day(40) })
  await q(`UPDATE accommodation_request SET on_behalf = true, submitted_by = $2 WHERE id = $1`, [requestId, raiser.user.id])
  const fingerprint = () => fp(
    [`SELECT status, decided_by, decision_reason FROM accommodation_request WHERE id = $1`, [requestId]],
    [`SELECT id, status FROM reservation WHERE request_id = $1`, [requestId]],
    [`SELECT bed_id, released_at FROM bed_claim WHERE bed_id = ANY($1::uuid[]) ORDER BY id`, [s.bedIds]],
  )
  return { s, subject, raiser, independent, requestId, fingerprint }
}

const REQUEST_ROWS: [string, () => Promise<Arr>][] = [
  ['approve a request (allocates the bed and creates the reservation)', async () => {
    const t = await requestScene()
    const run = (w: { rc: any }) => approveRequest(w.rc, { requestId: t.requestId, bedId: t.s.bedIds[0] })
    return { subject: () => run(t.subject), others: [{ label: 'the officer who filed it for them', run: () => run(t.raiser) }], independent: () => run(t.independent), fingerprint: t.fingerprint, entities: [t.requestId] }
  }],
  ['reject a request', async () => {
    const t = await requestScene()
    const run = (w: { rc: any }) => rejectRequest(w.rc, { requestId: t.requestId, reason: 'No capacity this month' })
    return { subject: () => run(t.subject), others: [{ label: 'the officer who filed it for them', run: () => run(t.raiser) }], independent: () => run(t.independent), fingerprint: t.fingerprint, entities: [t.requestId] }
  }],
  ['send a request back for changes', async () => {
    const t = await requestScene()
    const run = (w: { rc: any }) => requestChanges(w.rc, { requestId: t.requestId, reason: 'Please give an end date' })
    return { subject: () => run(t.subject), others: [{ label: 'the officer who filed it for them', run: () => run(t.raiser) }], independent: () => run(t.independent), fingerprint: t.fingerprint, entities: [t.requestId] }
  }],
  ['ask a Policy Approver for an exception', async () => {
    const t = await requestScene()
    const run = (w: { rc: any }) => requestException(w.rc, { requestId: t.requestId, reason: 'Needs this room', kinds: ['gender'] })
    return { subject: () => run(t.subject), others: [{ label: 'the officer who filed it for them', run: () => run(t.raiser) }], independent: () => run(t.independent), fingerprint: t.fingerprint, entities: [t.requestId] }
  }],
  ...(['grant', 'decline'] as const).map((kind): [string, () => Promise<Arr>] => [`${kind} an exception (Policy Approver)`, async () => {
    const s = await RQ.scenario({ beds: 2 })
    const pa = (role: 'AA' | 'Mgr' = 'Mgr') => RQ.who(role, { siteIds: [s.siteId], caps: ['PolicyApprover'] })
    const subject = await pa(), raiser = await pa(), asker = await pa('AA'), independent = await pa()
    const requestId = await mkRequest({ staffId: subject.staffId, siteId: s.siteId, arrival: RQ.day(10), end: RQ.day(40) })
    await q(`UPDATE accommodation_request SET on_behalf = true, submitted_by = $2 WHERE id = $1`, [requestId, raiser.user.id])
    const ask = await requestException(asker.rc, { requestId, reason: 'Needs this room', kinds: ['gender'] })
    if (!ask.ok) throw new Error('ask: ' + ask.reason)
    const run = (w: { rc: any }) => kind === 'grant'
      ? grantException(w.rc, { requestId, kinds: ['gender'], reason: 'Approved by the manager', evidence: 'memo 14 Oct' })
      : declineException(w.rc, { requestId, reason: 'Not justified' })
    return {
      subject: () => run(subject),
      others: [
        { label: 'the officer who filed it for them', run: () => run(raiser) },
        { label: 'the Accommodation Admin who asked for the exception (also a Policy Approver)', run: () => run(asker) },
      ],
      independent: () => run(independent),
      fingerprint: () => fp([`SELECT status FROM accommodation_request WHERE id = $1`, [requestId]], [`SELECT status FROM request_exception_ask WHERE request_id = $1`, [requestId]], [`SELECT id FROM eligibility_exception WHERE request_id = $1`, [requestId]]),
      entities: [requestId],
    }
  }]),
  ['confirm a bulk allocation (each row goes through the same approval)', async () => {
    const t = await requestScene()
    const preview = await previewBulkAllocation(t.independent.rc, { siteId: t.s.siteId, requestIds: [t.requestId] })
    if (!preview.ok) throw new Error('preview: ' + preview.reason)
    // the row for the subject is only in the batch when someone else previewed it; the confirmation then refuses it row by row
    const confirm = async (w: { rc: any }): Promise<Result<unknown>> => {
      const r = await confirmBulkAllocation(w.rc, { batchId: preview.data.batchId })
      if (r.ok && r.data.reserved === 0 && r.data.failed === 1) return fail.sod('That row was refused: separation of duties (D-26)')
      return r
    }
    const independent2 = await RQ.who('AA', { siteIds: [t.s.siteId] })
    return { subject: () => confirm(t.subject), others: [{ label: 'the officer who filed it for them', run: () => confirm(t.raiser) }], independent: () => confirm(independent2), fingerprint: t.fingerprint, entities: [t.requestId] }
  }],
  ...(['cancel', 'extend the no-show deadline of'] as const).map((verb): [string, () => Promise<Arr>] => [`${verb} a reservation`, async () => {
    const s = await RQ.scenario({ beds: 2 })
    const subject = await RQ.who('AA', { siteIds: [s.siteId] })
    const independent = await RQ.who('AA', { siteIds: [s.siteId] })
    const requestId = await mkRequest({ staffId: subject.staffId, siteId: s.siteId, arrival: RQ.day(4), end: RQ.day(9) })
    const done = await approveRequest(independent.rc, { requestId, bedId: s.bedIds[0] })
    if (!done.ok) throw new Error('approve: ' + done.reason)
    const reservationId = done.data.reservationId
    const run = (w: { rc: any }) => verb === 'cancel' ? cancelReservation(w.rc, { reservationId, reason: 'No longer needed' }) : extendNoShow(w.rc, { reservationId, reason: 'Flight delayed' })
    return {
      subject: () => run(subject), independent: () => run(independent),
      fingerprint: () => fp([`SELECT status, no_show_extended, cancel_reason FROM reservation WHERE id = $1`, [reservationId]], [`SELECT released_at FROM bed_claim WHERE bed_id = $1 ORDER BY id`, [s.bedIds[0]]]),
      entities: [reservationId],
    }
  }]),
]

/* ---------------- waitlist and offers ---------------- */

async function waitlistScene() {
  const w = await WL.world({ beds: 3 })
  const win = WL.window()
  const subject = await WL.person('AA', { siteIds: [w.siteId] })
  const independent = await WL.person('AA', { siteIds: [w.siteId] })
  const independent2 = await WL.person('AA', { siteIds: [w.siteId] })
  const e = await addToWaitlist(w.rec.rc(win.clock), { staffId: subject.staffId, siteId: w.siteId, arrival: win.day(5), end: win.day(65) })
  if (!e.ok) throw new Error('waitlist: ' + e.reason)
  const entryId = e.data.entryId
  const fingerprint = () => fp(
    [`SELECT status, close_reason FROM waitlist_entry WHERE id = $1`, [entryId]],
    [`SELECT id, status FROM bed_offer WHERE waitlist_entry_id = $1`, [entryId]],
    [`SELECT bed_id, kind, released_at FROM bed_claim WHERE bed_id = ANY($1::uuid[]) ORDER BY id`, [w.bedIds]],
    [`SELECT id FROM reservation WHERE staff_id = $1`, [subject.staffId]],
  )
  return { w, win, subject, independent, independent2, entryId, fingerprint }
}

const WAITLIST_ROWS: [string, () => Promise<Arr>][] = [
  ['offer a held bed to a waitlisted person', async () => {
    const t = await waitlistScene()
    const run = (p: { rc: (c: any) => any }) => createOffer(p.rc(t.win.clock), { entryId: t.entryId, bedId: t.w.bedIds[0], overrideReason: 'me first' })
    return { subject: () => run(t.subject), independent: () => run(t.independent), fingerprint: t.fingerprint, entities: [t.entryId] }
  }],
  ['"offer to the next in queue" when the next in queue is the actor', async () => {
    const t = await waitlistScene()
    const run = (p: { rc: (c: any) => any }) => offerToNext(p.rc(t.win.clock), { bedId: t.w.bedIds[0] })
    return { subject: () => run(t.subject), independent: () => run(t.independent), fingerprint: t.fingerprint, entities: [t.entryId] }
  }],
  ['record that an offer was delivered (confirm delivery)', async () => {
    const t = await waitlistScene()
    const o = await createOffer(t.independent.rc(t.win.clock), { entryId: t.entryId, bedId: t.w.bedIds[0] })
    if (!o.ok) throw new Error('offer: ' + o.reason)
    const run = (p: { rc: (c: any) => any }) => confirmDelivery(p.rc(t.win.clock), { offerId: o.data.offerId, via: 'offline', note: 'Told at the desk at 10:00' })
    return { subject: () => run(t.subject), independent: () => run(t.independent2), fingerprint: t.fingerprint, entities: [t.entryId, o.data.offerId] }
  }],
  ['accept an offer on behalf of the offered person', async () => {
    const t = await waitlistScene()
    const o = await createOffer(t.independent.rc(t.win.clock), { entryId: t.entryId, bedId: t.w.bedIds[0] })
    if (!o.ok) throw new Error('offer: ' + o.reason)
    const run = (p: { rc: (c: any) => any }) => acceptOfferOnBehalf(p.rc(t.win.clock), { offerId: o.data.offerId, consent: 'Said yes by phone at 14:10' })
    return { subject: () => run(t.subject), independent: () => run(t.independent2), fingerprint: t.fingerprint, entities: [t.entryId, o.data.offerId] }
  }],
  ['renew a waitlist entry', async () => {
    const t = await waitlistScene()
    const run = (p: { rc: (c: any) => any }) => renewEntry(p.rc(t.win.clock), { entryId: t.entryId })
    return { subject: () => run(t.subject), independent: () => run(t.independent), fingerprint: t.fingerprint, entities: [t.entryId] }
  }],
]

/* ---------------- stays: check-in, checkout, transfer, swap consent, extension ---------------- */

const STAY_ROWS: [string, () => Promise<Arr>][] = [
  ['check a reservation in (process the check-in)', async () => {
    const w = await ST.world({ beds: 3 })
    const subject = await ST.person('Rec', { siteIds: [w.siteId] })
    const r = await ST.mkReservation({ bedId: w.bedIds[0], staffId: subject.staffId, from: ST.day(0), to: ST.day(10) })
    return {
      subject: () => checkIn(subject.rc, { reservationId: r.reservationId }), independent: () => checkIn(w.rec.rc, { reservationId: r.reservationId }),
      fingerprint: () => fp([`SELECT status FROM reservation WHERE id = $1`, [r.reservationId]], [`SELECT id FROM stay WHERE staff_id = $1`, [subject.staffId]], [`SELECT state FROM bed WHERE id = $1`, [w.bedIds[0]]]),
      entities: [r.reservationId],
    }
  }],
  ['process a checkout', async () => {
    const w = await ST.world({ beds: 3 })
    const subject = await ST.person('Rec', { siteIds: [w.siteId] })
    const s = await ST.mkStay({ bedId: w.bedIds[0], staffId: subject.staffId, from: ST.day(-5), to: ST.day(30) })
    return {
      subject: () => processCheckout(subject.rc, { stayId: s.stayId, note: null }), independent: () => processCheckout(w.rec.rc, { stayId: s.stayId, note: null }),
      fingerprint: () => fp([`SELECT status FROM stay WHERE id = $1`, [s.stayId]], [`SELECT state FROM bed WHERE id = $1`, [w.bedIds[0]]], [`SELECT released_at FROM bed_claim WHERE id = $1`, [s.claimId]]),
      entities: [s.stayId],
    }
  }],
  ['acknowledge a checkout request', async () => {
    const w = await ST.world({ beds: 3 })
    const subject = await ST.person('Rec', { siteIds: [w.siteId] })
    const s = await ST.mkStay({ bedId: w.bedIds[0], staffId: subject.staffId, from: ST.day(-5), to: ST.day(30) })
    const req = await requestCheckout(ST.as(subject, 'Res').rc, { stayId: s.stayId, departureDate: ST.day(5), note: null })
    if (!req.ok) throw new Error('checkout request: ' + req.reason)
    return {
      subject: () => acknowledgeCheckout(subject.rc, { id: req.data.id }), independent: () => acknowledgeCheckout(w.rec.rc, { id: req.data.id }),
      fingerprint: () => fp([`SELECT status FROM checkout_request WHERE id = $1`, [req.data.id]]), entities: [req.data.id],
    }
  }],
  ...(['approve', 'reject'] as const).map((verb): [string, () => Promise<Arr>] => [`${verb} a transfer`, async () => {
    const w = await ST.world({ beds: 4 })
    const subject = await ST.person('AA', { siteIds: [w.siteId] })
    const raiser = await ST.person('AA', { siteIds: [w.siteId] })
    const independent = await ST.person('AA', { siteIds: [w.siteId] })
    const s = await ST.mkStay({ bedId: w.bedIds[0], staffId: subject.staffId, from: ST.day(-5), to: ST.day(30) })
    const t = await requestTransfer(raiser.rc, { stayId: s.stayId, destinationBedId: w.bedIds[1], destinationSiteId: null, reason: 'Noisy room', neededBy: null, linkedExtensionId: null })
    if (!t.ok) throw new Error('transfer: ' + t.reason)
    const id = t.data.id
    const run = (p: { rc: any }) => verb === 'approve' ? approveTransfer(p.rc, { id, destinationBedId: null, note: null }) : rejectTransfer(p.rc, { id, reason: 'Not now' })
    return {
      subject: () => run(subject), others: [{ label: 'the Accommodation Admin who raised it', run: () => run(raiser) }], independent: () => run(independent),
      fingerprint: () => fp([`SELECT status, source_approved_by, destination_approved_by FROM transfer_request WHERE id = $1`, [id]], [`SELECT bed_id FROM stay WHERE id = $1`, [s.stayId]]), entities: [id],
    }
  }]),
  ['carry out an approved transfer (Reception)', async () => {
    const w = await ST.world({ beds: 4 })
    const subject = await ST.person('Rec', { siteIds: [w.siteId] })
    const independentAa = await ST.person('AA', { siteIds: [w.siteId] })
    const s = await ST.mkStay({ bedId: w.bedIds[0], staffId: subject.staffId, from: ST.day(-5), to: ST.day(30) })
    const t = await requestTransfer(w.aa.rc, { stayId: s.stayId, destinationBedId: w.bedIds[1], destinationSiteId: null, reason: 'Noisy room', neededBy: null, linkedExtensionId: null })
    if (!t.ok) throw new Error('transfer: ' + t.reason)
    const a = await approveTransfer(independentAa.rc, { id: t.data.id, destinationBedId: null, note: null })
    if (!a.ok) throw new Error('approve: ' + a.reason)
    return {
      subject: () => executeTransfer(subject.rc, { id: t.data.id }), independent: () => executeTransfer(w.rec.rc, { id: t.data.id }),
      fingerprint: () => fp([`SELECT status FROM transfer_request WHERE id = $1`, [t.data.id]], [`SELECT bed_id, claim_id FROM stay WHERE id = $1`, [s.stayId]], [`SELECT state FROM bed WHERE id = ANY($1::uuid[]) ORDER BY id`, [w.bedIds]]), entities: [t.data.id, s.stayId],
    }
  }],
  ...(['approve', 'reject'] as const).map((verb): [string, () => Promise<Arr>] => [`${verb} an extension`, async () => {
    const w = await ST.world({ beds: 3 })
    const subject = await ST.person('AA', { siteIds: [w.siteId] })
    const raiser = await ST.person('AA', { siteIds: [w.siteId] })
    const independent = await ST.person('AA', { siteIds: [w.siteId] })
    const s = await ST.mkStay({ bedId: w.bedIds[0], staffId: subject.staffId, from: ST.day(-5), to: ST.day(30) })
    const e = await requestExtension(raiser.rc, { stayId: s.stayId, newEnd: ST.day(45), reason: 'Project runs on' })
    if (!e.ok) throw new Error('extension: ' + e.reason)
    const id = e.data.id
    const run = (p: { rc: any }) => verb === 'approve' ? approveExtension(p.rc, { id, note: null }) : rejectExtension(p.rc, { id, reason: 'Not now' })
    return {
      subject: () => run(subject), others: [{ label: 'the Accommodation Admin who raised it', run: () => run(raiser) }], independent: () => run(independent),
      fingerprint: () => fp([`SELECT status FROM extension_request WHERE id = $1`, [id]], [`SELECT upper(period)::text AS end FROM bed_claim WHERE id = $1`, [s.claimId]]), entities: [id],
    }
  }]),
]

/* ---------------- emergency check-in ---------------- */

const EMERGENCY_ROWS: [string, () => Promise<Arr>][] = [
  ['start an emergency check-in for oneself', async () => {
    const w = await EM.world()
    const other = await mkStaff()
    return {
      subject: () => initiateEmergency(w.rec.rc(EM.clockAt(0)), { staffId: w.rec.user.staffId, bedId: w.bedIds[0], reason: 'Flood in block D, relocated overnight' }),
      independent: () => initiateEmergency(w.rec.rc(EM.clockAt(0)), { staffId: other.id, bedId: w.bedIds[0], reason: 'Flood in block D, relocated overnight' }),
      fingerprint: () => fp([`SELECT staff_id, status FROM emergency_checkin WHERE site_id = $1 ORDER BY created_at`, [w.siteId]], [`SELECT state FROM bed WHERE id = $1`, [w.bedIds[0]]]),
      entities: [w.siteId],
    }
  }],
  ...(['approve', 'reject'] as const).map((verb): [string, () => Promise<Arr>] => [`${verb} an emergency check-in`, async () => {
    const w = await EM.world()
    const subject = await EM.who('AA', { siteIds: [w.siteId] })
    const e = await EM.start(w, { by: w.rec, staffId: subject.user.staffId, bedIndex: 0 })
    const run = (p: { rc: (c: any) => any }) => verb === 'approve' ? approveEmergency(p.rc(EM.clockAt(1)), { caseId: e.caseId }) : rejectEmergency(p.rc(EM.clockAt(1)), { caseId: e.caseId, reason: 'Not an emergency' })
    return {
      subject: () => run(subject), others: [{ label: 'the Reception officer who started it', run: () => run(w.rec) }], independent: () => run(w.aa),
      fingerprint: () => fp([`SELECT status, decided_by FROM emergency_checkin WHERE id = $1`, [e.caseId]], [`SELECT status FROM stay WHERE id = $1`, [e.stayId]]), entities: [e.caseId],
      refusalAudit: ['emergency.decision_refused'],
    }
  }]),
  ['close a relocation task (after a rejection)', async () => {
    const w = await EM.world()
    const subject = await EM.who('AA', { siteIds: [w.siteId] })
    const e = await EM.start(w, { by: w.rec, staffId: subject.user.staffId, bedIndex: 0 })
    const rej = await rejectEmergency(w.aa.rc(EM.clockAt(2)), { caseId: e.caseId, reason: 'Not an emergency' })
    if (!rej.ok) throw new Error('reject: ' + rej.reason)
    await EM.checkOutByHand(e.stayId) // the resident has gone, so only the duty is in question
    const taskId = rej.data.task!.id
    const run = (p: { rc: (c: any) => any }) => completeTask(p.rc(EM.clockAt(3)), { taskId, note: 'Checked out and moved' })
    return {
      subject: () => run(subject), independent: () => run(w.aa),
      fingerprint: () => fp([`SELECT done_at, done_by FROM task WHERE id = $1`, [taskId]]), entities: [taskId],
    }
  }],
]

/* ---------------- exit, clearance, rehire ---------------- */

async function leaverCase(role: 'Rec' | 'AA' = 'Rec') {
  const w = await XT.world()
  const subject = await XT.who(role, { siteIds: [w.siteId] })
  await XT.mkStayFor({ staffId: subject.user.staffId, bedId: w.bedIds[2], from: '2026-10-01' })
  // an administrator is marked Left by a Super Admin only
  const left = await markLeft(role === 'AA' ? w.sa.rc() : w.aa.rc(), { staffId: subject.user.staffId, effectiveDate: '2026-10-14', reason: 'Resigned', confirmPassword: PASSWORD })
  if (!left.ok) throw new Error('mark left: ' + left.reason)
  const items = await XT.itemsOf(left.data.caseId)
  return { w, subject, caseId: left.data.caseId, items }
}

const EXIT_ROWS: [string, () => Promise<Arr>][] = [
  ['mark an employee as Left (oneself)', async () => {
    const w = await XT.world()
    const r = await XT.resident({ bedId: w.bedIds[0] })
    return {
      subject: () => markLeft(w.aa.rc(), { staffId: w.aa.user.staffId, effectiveDate: '2026-10-14', reason: 'Resigned', confirmPassword: PASSWORD }),
      independent: () => markLeft(w.aa.rc(), { staffId: r.staffId, effectiveDate: '2026-10-14', reason: 'Resigned', confirmPassword: PASSWORD }),
      fingerprint: () => XT.snapshot(w.aa.user.staffId, w.aa.user.id), entities: [w.aa.user.staffId],
    }
  }],
  ['mark employees as Left in bulk (oneself in the list)', async () => {
    const w = await XT.world()
    const emp = (await q(`SELECT employee_id FROM staff_profile WHERE id = $1`, [w.aa.user.staffId]))[0].employee_id as string
    const r = await XT.resident({ bedId: w.bedIds[0] })
    const rEmp = r.employeeId
    const sa2 = await XT.who('SA')
    // the row for oneself is blocked in the preview; the other row is fine
    const asSod = async (rc: any, id: string): Promise<Result<unknown>> => {
      const p = await previewBulkExit(rc, { employeeIds: [id], effectiveDate: '2026-10-14', reason: 'Restructure' } as any)
      if (p.ok && p.data.batch.rows.length === 1 && p.data.batch.rows[0].outcome === 'blocked') return fail.sod(p.data.batch.rows[0].message)
      return p
    }
    return { subject: () => asSod(w.aa.rc(), emp), independent: () => asSod(sa2.rc(), rEmp), fingerprint: () => XT.snapshot(w.aa.user.staffId, w.aa.user.id), entities: [w.aa.user.staffId] }
  }],
  ['complete a clearance item (own clearance)', async () => {
    const t = await leaverCase()
    const item = t.items.find(i => i.checklist_key === 'belongings')!.id
    return { subject: () => completeItem(t.subject.rc(), { itemId: item, note: 'mine' }), independent: () => completeItem(t.w.rec.rc(), { itemId: item, note: 'collected' }), fingerprint: () => fp([`SELECT status FROM clearance_item WHERE case_id = $1 ORDER BY id`, [t.caseId]]), entities: [t.caseId, item] }
  }],
  ['mark a clearance item outstanding (own clearance)', async () => {
    const t = await leaverCase()
    const item = t.items.find(i => i.checklist_key === 'belongings')!.id
    return { subject: () => markOutstanding(t.subject.rc(), { itemId: item, note: 'not yet' }), independent: () => markOutstanding(t.w.rec.rc(), { itemId: item, note: 'not yet' }), fingerprint: () => fp([`SELECT status FROM clearance_item WHERE case_id = $1 ORDER BY id`, [t.caseId]]), entities: [t.caseId, item] }
  }],
  ['reopen a clearance item (own clearance)', async () => {
    const t = await leaverCase('AA')
    const item = t.items.find(i => i.checklist_key === 'belongings')!.id
    const done = await completeItem(t.w.rec.rc(), { itemId: item, note: 'collected' })
    if (!done.ok) throw new Error('complete: ' + done.reason)
    return { subject: () => reopenItem(t.subject.rc(), { itemId: item, reason: 'mistake' }), independent: () => reopenItem(t.w.aa.rc(), { itemId: item, reason: 'mistake' }), fingerprint: () => fp([`SELECT status FROM clearance_item WHERE case_id = $1 ORDER BY id`, [t.caseId]]), entities: [t.caseId, item] }
  }],
  ['waive a clearance item (Policy Approver, own clearance)', async () => {
    const w = await XT.world()
    const subject = await XT.who('Mgr', { siteIds: [w.siteId], caps: ['PolicyApprover'] })
    await XT.mkStayFor({ staffId: subject.user.staffId, bedId: w.bedIds[2], from: '2026-10-01' })
    const left = await markLeft(w.sa.rc(), { staffId: subject.user.staffId, effectiveDate: '2026-10-14', reason: 'Resigned', confirmPassword: PASSWORD })
    if (!left.ok) throw new Error('mark left: ' + left.reason)
    const item = (await XT.itemsOf(left.data.caseId))[0].id
    const args = { itemId: item, reason: 'Write it off', evidence: 'Police report 123', confirmPassword: PASSWORD }
    return { subject: () => waiveItem(subject.rc(), args), independent: () => waiveItem(w.pa.rc(), args), fingerprint: () => fp([`SELECT status FROM clearance_item WHERE id = $1`, [item]]), entities: [left.data.caseId, item] }
  }],
  ['close a clearance case (own clearance)', async () => {
    const w = await XT.world()
    const subject = await XT.who('AA', { siteIds: [w.siteId] })
    const left = await markLeft(w.sa.rc(), { staffId: subject.user.staffId, effectiveDate: '2026-10-14', reason: 'Resigned', confirmPassword: PASSWORD })
    if (!left.ok) throw new Error('mark left: ' + left.reason)
    for (const i of await XT.itemsOf(left.data.caseId)) {
      if (!i.mandatory) continue
      const done = await completeItem(i.owner === 'Maintenance' ? w.mc.rc() : i.owner === 'AA' ? w.aa.rc() : w.rec.rc(), { itemId: i.id, note: 'done' })
      if (!done.ok && done.code !== 'conflict') throw new Error('item: ' + done.reason)
    }
    const caseId = left.data.caseId
    return { subject: () => closeCase(subject.rc(), { caseId }), independent: () => closeCase(w.aa.rc(), { caseId }), fingerprint: () => fp([`SELECT status FROM clearance_case WHERE id = $1`, [caseId]]), entities: [caseId] }
  }],
  ['rehire a former employee (oneself)', async () => {
    const w = await XT.world()
    const r = await mkStaff({ status: 'left' })
    const arg = (staffId: string) => ({ staffId, reason: 'Back on the payroll', confirmPassword: PASSWORD })
    // the actor's own profile is the one that is Left
    await q(`UPDATE staff_profile SET employment_status = 'left', left_at = now() WHERE id = $1`, [w.aa.user.staffId])
    return { subject: () => reactivateStaff(w.aa.rc(), arg(w.aa.user.staffId)), independent: () => reactivateStaff(w.sa.rc(), arg(r.id)), fingerprint: () => fp([`SELECT employment_status FROM staff_profile WHERE id = ANY($1::uuid[]) ORDER BY id`, [[w.aa.user.staffId, r.id]]]), entities: [w.aa.user.staffId] }
  }],
]

/* ---------------- keys ---------------- */

async function keyScene(status: 'in_cabinet' | 'issued' | 'lost' | 'damaged', role: 'Rec' | 'AA' = 'Rec') {
  const w = await KY.world({ beds: 3 })
  const subject = await KY.person(role, { siteIds: [w.siteId] })
  await KY.mkStayFor({ staffId: subject.staffId, bedId: w.bedIds[0] })
  const holder = status === 'in_cabinet' ? undefined : subject.staffId
  const itemId = await KY.mkItem({ siteId: w.siteId, bedId: w.bedIds[0], holderStaffId: holder, status })
  const fingerprint = () => fp([`SELECT status, holder_staff_id, replaced_by, archived_at FROM handover_item WHERE id = $1`, [itemId]], [`SELECT kind FROM handover_event WHERE item_id = $1 ORDER BY created_at, id`, [itemId]])
  return { w, subject, itemId, fingerprint }
}
const KEY_ROWS: [string, () => Promise<Arr>][] = [
  ['issue a key or asset (to oneself)', async () => {
    const t = await keyScene('in_cabinet')
    // the same call for somebody else: a resident of another bed, with that bed's key
    const other = await KY.resident(t.w.bedIds[1])
    const otherKey = await KY.mkItem({ siteId: t.w.siteId, bedId: t.w.bedIds[1] })
    return { subject: () => issueItem(t.subject.rc, { itemId: t.itemId, staffId: t.subject.staffId, dueBack: null, note: null }), independent: () => issueItem(t.w.rec.rc, { itemId: otherKey, staffId: other.staffId, dueBack: null, note: null }), fingerprint: t.fingerprint, entities: [t.itemId] }
  }],
  ['record the return of a key or asset (one that the actor holds)', async () => {
    const t = await keyScene('issued')
    return { subject: () => returnItem(t.subject.rc, { itemId: t.itemId, onBehalf: undefined, note: null }), independent: () => returnItem(t.w.rec.rc, { itemId: t.itemId, onBehalf: undefined, note: null }), fingerprint: t.fingerprint, entities: [t.itemId] }
  }],
  ['record a key or asset as lost (one that the actor holds)', async () => {
    const t = await keyScene('issued')
    return { subject: () => markLost(t.subject.rc, { itemId: t.itemId, note: 'I lost it', attachmentIds: undefined }), independent: () => markLost(t.w.rec.rc, { itemId: t.itemId, note: 'Resident lost it', attachmentIds: undefined }), fingerprint: t.fingerprint, entities: [t.itemId] }
  }],
  ['record a key or asset as damaged (one that the actor holds)', async () => {
    const t = await keyScene('issued')
    return { subject: () => markDamaged(t.subject.rc, { itemId: t.itemId, note: 'I broke it', attachmentIds: undefined }), independent: () => markDamaged(t.w.rec.rc, { itemId: t.itemId, note: 'Resident broke it', attachmentIds: undefined }), fingerprint: t.fingerprint, entities: [t.itemId] }
  }],
  ['record that a lost key was found (one that the actor lost)', async () => {
    const t = await keyScene('lost')
    return { subject: () => foundItem(t.subject.rc, { itemId: t.itemId, to: 'cabinet', note: null }), independent: () => foundItem(t.w.rec.rc, { itemId: t.itemId, to: 'cabinet', note: null }), fingerprint: t.fingerprint, entities: [t.itemId] }
  }],
  ['retire a lost key (one that the actor lost)', async () => {
    const t = await keyScene('lost', 'AA')
    return { subject: () => retireItem(t.subject.rc, { itemId: t.itemId, reason: 'Written off' }), independent: () => retireItem(t.w.aa.rc, { itemId: t.itemId, reason: 'Written off' }), fingerprint: t.fingerprint, entities: [t.itemId] }
  }],
  ['replace a lost key (one that the actor lost)', async () => {
    const t = await keyScene('lost', 'AA')
    return { subject: () => replaceItem(t.subject.rc, { itemId: t.itemId, newCode: 'K-NEW-1', note: null }), independent: () => replaceItem(t.w.aa.rc, { itemId: t.itemId, newCode: 'K-NEW-2', note: null }), fingerprint: t.fingerprint, entities: [t.itemId] }
  }],
]

/* ---------------- housekeeping and inspection ---------------- */

async function cleaningScene() {
  const s = await RD.scene({ beds: 3 })
  const v = await RD.vacate(s, s.bedIds[0])
  const fingerprint = () => fp([`SELECT status, assigned_to_staff, cleaned_by_staff, inspected_by_staff FROM cleaning_task WHERE id = $1`, [v.taskId]], [`SELECT state FROM bed WHERE id = $1`, [s.bedIds[0]]])
  return { s, v, fingerprint }
}
const READINESS_ROWS: [string, () => Promise<Arr>][] = [
  ['assign a cleaning task (to someone who lives in that room)', async () => {
    const t = await cleaningScene()
    const neighbour = await RD.housekeeper()
    await RD.mkStay({ bedId: t.s.bedIds[1], staffId: neighbour.staffId, from: RD.day(-5), to: null })
    const other = await RD.housekeeper()
    return {
      subject: () => assignCleaning(t.s.rec.rc, { taskId: t.v.taskId, housekeeperStaffId: neighbour.staffId, note: null }),
      independent: () => assignCleaning(t.s.rec.rc, { taskId: t.v.taskId, housekeeperStaffId: other.staffId, note: null }),
      fingerprint: t.fingerprint, entities: [t.v.taskId],
    }
  }],
  ['clean a room (one that the cleaner lives in)', async () => {
    const t = await cleaningScene()
    const neighbour = await RD.housekeeper()
    await RD.mkStay({ bedId: t.s.bedIds[1], staffId: neighbour.staffId, from: RD.day(-5), to: null })
    await q(`UPDATE cleaning_task SET assigned_to_staff = $2 WHERE id = $1`, [t.v.taskId, neighbour.staffId])
    return {
      subject: () => completeCleaning(neighbour.rc, { taskId: t.v.taskId, checklist: RD.FULL, notes: null }),
      independent: async () => {
        await q(`UPDATE cleaning_task SET assigned_to_staff = $2 WHERE id = $1`, [t.v.taskId, t.s.hk.staffId])
        return completeCleaning(t.s.hk.rc, { taskId: t.v.taskId, checklist: RD.FULL, notes: null })
      },
      fingerprint: t.fingerprint, entities: [t.v.taskId],
    }
  }],
  ...(['pass', 'fail'] as const).map((verb): [string, () => Promise<Arr>] => [`${verb} a final inspection (the cleaner's own work)`, async () => {
    const t = await cleaningScene()
    // One person holds both capabilities, cleans, and then tries to inspect their own work.
    const both = await RD.inspector(t.s.siteId, 'Rec')
    await grantCapability(both.userId, 'Housekeeping')
    const asCleaner = rcFor(both.userId, { role: 'Rec', sites: [t.s.siteId], caps: ['FinalInspection', 'Housekeeping'], staffId: both.staffId }, both.rc.clock as never)
    await q(`UPDATE cleaning_task SET assigned_to_staff = $2 WHERE id = $1`, [t.v.taskId, both.staffId])
    const cleaned = await completeCleaning(asCleaner, { taskId: t.v.taskId, checklist: RD.FULL, notes: null })
    if (!cleaned.ok) throw new Error('clean: ' + cleaned.reason)
    const run = (rc: any) => verb === 'pass' ? passInspection(rc, { taskId: t.v.taskId, note: null }) : failInspection(rc, { taskId: t.v.taskId, note: 'Not good enough' })
    return { subject: () => run(asCleaner), independent: () => run(t.s.insp.rc), fingerprint: t.fingerprint, entities: [t.v.taskId] }
  }]),
  ['pass a final inspection (of the room the inspector lives in)', async () => {
    const t = await cleaningScene()
    await q(`UPDATE cleaning_task SET assigned_to_staff = $2 WHERE id = $1`, [t.v.taskId, t.s.hk.staffId])
    const cleaned = await completeCleaning(t.s.hk.rc, { taskId: t.v.taskId, checklist: RD.FULL, notes: null })
    if (!cleaned.ok) throw new Error('clean: ' + cleaned.reason)
    await RD.mkStay({ bedId: t.s.bedIds[2], staffId: t.s.insp.staffId, from: RD.day(-3), to: null })
    const other = await RD.inspector(t.s.siteId)
    return { subject: () => passInspection(t.s.insp.rc, { taskId: t.v.taskId, note: null }), independent: () => passInspection(other.rc, { taskId: t.v.taskId, note: null }), fingerprint: t.fingerprint, entities: [t.v.taskId] }
  }],
]

/* ---------------- accounts, access, staff, delegation ---------------- */

async function sa() {
  const u = await makeUser({ roles: [{ role: 'SA', all: true }] })
  return { u, rc: rcFor(u.id, { role: 'SA', sites: 'all', staffId: u.staffId }, RQ.newClock()) }
}
const ACCESS_ROWS: [string, () => Promise<Arr>][] = [
  ...(['role change', 'capability grant'] as const).map((what): [string, () => Promise<Arr>] => [`decide a ${what} (maker-checker)`, async () => {
    const maker = await sa(), target = await sa(), checker = await sa()
    const site = (await WL.world({ beds: 0 })).siteId
    let id: string
    if (what === 'role change') {
      const r = await requestRoleChange(maker.rc, { kind: 'add', userId: target.u.id, role: 'Rec', scopeKind: 'site', siteId: site, reason: 'New desk officer' })
      if (!r.ok) throw new Error(r.reason)
      id = r.data.requestId
    } else {
      const r = await requestGrant(maker.rc, { userId: target.u.id, capability: 'NightKeys', reason: 'Night shift cover' })
      if (!r.ok) throw new Error(r.reason)
      id = r.data.grantId
    }
    const run = (p: { rc: any }) => what === 'role change' ? decideRoleChange(p.rc, { requestId: id, decision: 'reject', note: 'Not needed' }) : decideGrant(p.rc, { grantId: id, decision: 'reject', note: 'Not needed' })
    return {
      subject: () => run(target), others: [{ label: 'the Super Admin who filed it', run: () => run(maker) }], independent: () => run(checker),
      fingerprint: () => fp([what === 'role change' ? `SELECT status FROM role_change_request WHERE id = $1` : `SELECT status FROM capability_grant WHERE id = $1`, [id]]), entities: [id],
    }
  }]),
  ...(['reset the password of', 'deactivate', 'end the sessions of'] as const).map((verb): [string, () => Promise<Arr>] => [`${verb} an account (oneself)`, async () => {
    // Administrator accounts are managed by a Super Admin only, so the person acting on their own account is a Super Admin.
    const subject = await sa(), other = await sa(), actor = await sa()
    const run = (rc: any, userId: string) => verb === 'deactivate' ? deactivateAccount(rc, { userId, reason: 'Left the company' }) : verb === 'reset the password of' ? resetPassword(rc, { userId, reason: 'Forgot it' }) : revokeUserSessions(rc, { userId, reason: 'Lost phone' })
    return {
      subject: () => run(subject.rc, subject.u.id), independent: () => run(actor.rc, other.u.id),
      fingerprint: () => fp([`SELECT status, must_change_password FROM user_account WHERE id = ANY($1::uuid[]) ORDER BY id`, [[subject.u.id, other.u.id]]]), entities: [subject.u.id],
    }
  }]),
  ['change staff details (own profile)', async () => {
    const w = await WL.world({ beds: 0 })
    const subject = await WL.person('AA', { siteIds: [w.siteId] })
    const other = await mkStaff()
    return {
      subject: () => updateStaff(subject.rc(WL.window().clock), { id: subject.staffId, department: 'Rooms' } as any), independent: () => updateStaff(w.aa.rc(WL.window().clock), { id: other.id, department: 'Rooms' } as any),
      fingerprint: () => fp([`SELECT department FROM staff_profile WHERE id = ANY($1::uuid[]) ORDER BY id`, [[subject.staffId, other.id]]]), entities: [subject.staffId],
    }
  }],
  ['archive a staff profile (own profile)', async () => {
    const w = await WL.world({ beds: 0 })
    const subject = await WL.person('AA', { siteIds: [w.siteId] })
    const other = await mkStaff()
    return {
      subject: () => archiveStaff(subject.rc(WL.window().clock), { id: subject.staffId, reason: 'Duplicate' } as any), independent: () => archiveStaff(w.aa.rc(WL.window().clock), { id: other.id, reason: 'Duplicate' } as any),
      fingerprint: () => fp([`SELECT archived_at FROM staff_profile WHERE id = ANY($1::uuid[]) ORDER BY id`, [[subject.staffId, other.id]]]), entities: [subject.staffId],
    }
  }],
  ['name a stand-in for oneself (delegation)', async () => {
    const w = await WL.world({ beds: 0 })
    const win = WL.window()
    const approver = await WL.person('AA', { siteIds: [w.siteId] })
    const standIn = await WL.person('AA', { siteIds: [w.siteId] })
    const asDelegation = (to: string) => createDelegation(approver.rc(win.clock), { toUserId: to, startsOn: win.day(1), endsOn: win.day(5), reason: 'Leave' } as any)
    return {
      subject: () => asDelegation(approver.user.id), subjectCode: 'invalid', independent: () => asDelegation(standIn.user.id),
      fingerprint: () => fp([`SELECT id FROM delegation WHERE from_user_id = $1`, [approver.user.id]]), entities: [approver.user.id],
    }
  }],
]

/* ---------------- the table ---------------- */

const TABLE: [string, [string, () => Promise<Arr>][]][] = [
  ['requests and allocation', REQUEST_ROWS],
  ['waitlist and offers', WAITLIST_ROWS],
  ['stays', STAY_ROWS],
  ['emergency check-in', EMERGENCY_ROWS],
  ['exit and clearance', EXIT_ROWS],
  ['keys', KEY_ROWS],
  ['housekeeping and inspection', READINESS_ROWS],
  ['access, staff, delegation', ACCESS_ROWS],
]

describe.each(TABLE)('AT-038 %s', (_group, rows) => {
  it.each(rows)('%s', async (_name, make) => {
    const a = await make()
    const before = { fp: await a.fingerprint(), audit: await auditRows(a.entities) }
    const attempts: { label: string; run: () => Promise<Result<unknown>>; code: Code }[] = [
      { label: 'the person it is about', run: a.subject, code: a.subjectCode ?? 'separation_of_duties' },
      ...(a.others ?? []).map(o => ({ label: o.label, run: o.run, code: o.code ?? 'separation_of_duties' as Code })),
    ]
    let refused = 0
    for (const at of attempts) {
      const r = await at.run()
      expect(r.ok, `${at.label} must be refused`).toBe(false)
      if (!r.ok) {
        expect(r.code, `${at.label}: ${r.reason}`).toBe(at.code)
        if (at.code === 'separation_of_duties') { expect(r.status).toBe(403); expect(r.next, 'says what to do next').toBeTruthy() }
      }
      refused++
      expect(await a.fingerprint(), `${at.label}: nothing changed`).toBe(before.fp)
      const rows = await auditRows(a.entities)
      const extra = rows.slice(before.audit.length)
      expect(extra.every(x => (a.refusalAudit ?? []).includes(x.action)), `${at.label}: a refusal writes no audit row (found ${extra.map(x => x.action)})`).toBe(true)
      expect(rows.length - before.audit.length, 'at most the documented refusal row per refusal').toBeLessThanOrEqual(refused * ((a.refusalAudit ?? []).length ? 1 : 0))
    }
    const ok = await a.independent()
    expect(ok.ok, ok.ok ? '' : `an independent person of the same role succeeds, got ${ok.code}: ${ok.reason}`).toBe(true)
  })
})

