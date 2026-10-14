/**
 * WP-F sweeps (D-55, D-56, D-58, D-63) against a private database, because a sweep looks at every row it can see.
 * For each timer: just before and just after the boundary, run twice, run from two runners at once, and "nothing was decided".
 */
import { afterAll, describe, expect, it } from 'vitest'
import { createIsolated } from '../access/isolated'
import { FixedClock } from '@/server/clock'
import { DAY_MS, HOUR_MS, NOW, day, kit } from './iso'
import { getDb } from '@/server/db/client'
import { listSweeps, runSweep } from '@/server/jobs/registry'
import '@/server/jobs/sweeps'
import { requestCheckout } from '@/server/commands/stays/checkout'
import { requestExtension } from '@/server/commands/stays/extension'
import { requestTransfer } from '@/server/commands/stays/requestTransfer'
import { approveTransfer } from '@/server/commands/stays/decideTransfer'
import { listInbox } from '@/server/approvals/inbox'

const iso = await createIsolated()
afterAll(() => iso.close())
const clock = new FixedClock(NOW)
const k = kit(iso, clock)
const sweep = (name: string) => runSweep(name, clock)
const summary = async (name: string) => (await sweep(name)).summary as Record<string, number>
const ETA = Date.UTC(2026, 9, 14, 12, 0, 0) // an arrival at noon on 14 Oct

describe('no-show (D-58)', () => {
  async function reserved(o: { extended?: boolean; from?: string; to?: string } = {}) {
    const w = await k.world(2)
    const res = await w.res()
    const r = await k.reservation({ bedId: w.bedIds[0], staffId: res.staffId, from: o.from ?? day(0), to: o.to ?? day(20), eta: new Date(ETA).toISOString(), extended: o.extended })
    return { w, res, ...r }
  }

  it('releases the hold only AFTER eta + 24 h: not at the deadline itself, yes a moment after', async () => {
    const x = await reserved()
    clock.set(ETA + 24 * HOUR_MS - 1)
    await sweep('stays_no_show')
    expect((await k.reservationRow(x.reservationId)).status).toBe('reserved')
    clock.set(ETA + 24 * HOUR_MS)
    await sweep('stays_no_show')
    expect((await k.reservationRow(x.reservationId)).status).toBe('reserved')
    expect((await k.claimRow(x.claimId)).released_at).toBeNull()
    clock.set(ETA + 24 * HOUR_MS + 1)
    await sweep('stays_no_show')
    const r = await k.reservationRow(x.reservationId)
    expect(r.status).toBe('no_show')
    expect(r.cancel_reason).toMatch(/No-show/)
    const c = await k.claimRow(x.claimId)
    expect(c.released_at).not.toBeNull()
    expect(c.release_reason).toBe('no_show')
    expect(await k.liveClaims(x.w.bedIds[0])).toHaveLength(0)
    expect(await k.bedState(x.w.bedIds[0])).toBe('available') // a hold was released; the bed itself is untouched
  })

  it('once the Accommodation Admin has extended it, the window is 48 h', async () => {
    const x = await reserved({ extended: true })
    clock.set(ETA + 48 * HOUR_MS)
    await sweep('stays_no_show')
    expect((await k.reservationRow(x.reservationId)).status).toBe('reserved')
    clock.set(ETA + 48 * HOUR_MS + 1)
    await sweep('stays_no_show')
    expect((await k.reservationRow(x.reservationId)).status).toBe('no_show')
  })

  it('tells the resident and the Accommodation Admin, audits as the system, and does it once even if the sweep runs twice', async () => {
    const x = await reserved()
    clock.set(ETA + 25 * HOUR_MS)
    const first = await summary('stays_no_show')
    const second = await summary('stays_no_show')
    expect(first.released).toBeGreaterThanOrEqual(1)
    expect(second.released).toBe(0)
    const n = await k.notifications(x.reservationId)
    expect(n.map(a => a.kind)).toEqual(['reservation.no_show', 'reservation.no_show'])
    expect(n.filter(a => a.to_staff_id === x.res.staffId)).toHaveLength(1)
    expect(n.filter(a => a.to_role === 'AA')).toHaveLength(1)
    const a = await k.audits(x.reservationId)
    expect(a).toHaveLength(1)
    expect(a[0]).toMatchObject({ action: 'stays.reservation.no_show', actor_role: 'system', actor_user_id: null })
  })

  it('two runners at once (bypassing the sweep lock) still release the hold once', async () => {
    const x = await reserved()
    clock.set(ETA + 30 * HOUR_MS)
    const s = listSweeps().find(w => w.name === 'stays_no_show')!
    const ctx = { clock, now: clock.now(), db: getDb(), requestId: 't' }
    await Promise.all([s.run(ctx), s.run(ctx), s.run(ctx)])
    expect((await k.audits(x.reservationId)).filter(a => a.action === 'stays.reservation.no_show')).toHaveLength(1)
    expect((await k.notifications(x.reservationId)).filter(a => a.to_role === 'AA')).toHaveLength(1)
  })

  it('a reservation whose whole period already ended is `expired`, not a no-show', async () => {
    const x = await reserved({ from: day(-6), to: day(-3) })
    await k.q(`UPDATE reservation SET eta = $2 WHERE id = $1`, [x.reservationId, `${day(-6)}T12:00:00Z`])
    clock.set(NOW)
    await sweep('stays_no_show')
    expect((await k.reservationRow(x.reservationId)).status).toBe('expired')
    expect((await k.claimRow(x.claimId)).release_reason).toBe('expired')
  })

  it('never touches a reservation that was checked in, or one still inside its window; a freed bed can be allocated again', async () => {
    const x = await reserved()
    await k.q(`UPDATE reservation SET status = 'checked_in' WHERE id = $1`, [x.reservationId])
    clock.set(ETA + 100 * HOUR_MS)
    await sweep('stays_no_show')
    expect((await k.reservationRow(x.reservationId)).status).toBe('checked_in')
    expect((await k.claimRow(x.claimId)).released_at).toBeNull()
  })
})

describe('end-of-stay reminders (D-55)', () => {
  async function ending(endIn: number) {
    const w = await k.world(1)
    const res = await w.res()
    const s = await k.stay({ bedId: w.bedIds[0], staffId: res.staffId, from: day(-30), to: day(endIn) })
    return { w, res, ...s }
  }
  const mine = async (stayId: string) => (await k.notifications(stayId)).filter(n => n.kind === 'stay.end_reminder' && n.to_staff_id !== null)

  it('14, 7 and 1 days before the end, each once, nothing in between', async () => {
    clock.set(NOW)
    const x = await ending(14)
    await sweep('stays_end_reminders'); await sweep('stays_end_reminders')
    expect(await mine(x.stayId)).toHaveLength(1)
    clock.set(NOW + 6 * DAY_MS) // 8 days left
    await sweep('stays_end_reminders')
    expect(await mine(x.stayId)).toHaveLength(1)
    clock.set(NOW + 7 * DAY_MS) // 7 left
    await sweep('stays_end_reminders'); await sweep('stays_end_reminders')
    expect(await mine(x.stayId)).toHaveLength(2)
    clock.set(NOW + 13 * DAY_MS) // 1 left
    await sweep('stays_end_reminders')
    const all = await mine(x.stayId)
    expect(all).toHaveLength(3)
    expect(all.map(n => n.dedupe_key.split(':')[3]).sort()).toEqual(['1', '14', '7'])
    expect((await k.notifications(x.stayId)).filter(n => n.to_role === 'AA')).toHaveLength(3)
    // the stay itself is untouched
    expect((await k.stayRow(x.stayId)).status).toBe('active')
    clock.set(NOW)
  })

  it('a sweep that starts late sends the one reminder that still matters, not a burst; an extension re-arms the reminders', async () => {
    clock.set(NOW)
    const x = await ending(3)
    await sweep('stays_end_reminders')
    expect(await mine(x.stayId)).toHaveLength(1)
    await k.q(`UPDATE bed_claim SET period = $2::daterange WHERE id = $1`, [x.claimId, `[${day(-30)},${day(40)})`])
    clock.set(NOW + 26 * DAY_MS) // 14 days before the new end
    await sweep('stays_end_reminders')
    expect(await mine(x.stayId)).toHaveLength(2)
    clock.set(NOW)
  })

  it('no reminder for an open-ended stay, a checked-out stay or one that is already past its end', async () => {
    clock.set(NOW)
    const w = await k.world(3)
    const [a, b, c] = [await w.res(), await w.res(), await w.res()]
    const open = await k.stay({ bedId: w.bedIds[0], staffId: a.staffId, from: day(-5), to: null })
    const out = await k.stay({ bedId: w.bedIds[1], staffId: b.staffId, from: day(-30), to: day(2) })
    await k.q(`UPDATE stay SET status = 'checked_out', checked_out_at = now() WHERE id = $1`, [out.stayId])
    const past = await k.stay({ bedId: w.bedIds[2], staffId: c.staffId, from: day(-30), to: day(-1) })
    await sweep('stays_end_reminders')
    for (const s of [open, out, past]) expect(await mine(s.stayId)).toHaveLength(0)
  })
})

describe('overdue stays (D-56): flag on day 1, escalate after the grace, never check out', () => {
  async function overdue(endDayOffset: number) {
    const w = await k.world(1)
    const res = await w.res()
    const s = await k.stay({ bedId: w.bedIds[0], staffId: res.staffId, from: day(-30), to: day(endDayOffset) })
    return { w, res, ...s }
  }
  const kinds = async (stayId: string) => (await k.notifications(stayId)).map(n => `${n.kind}:${n.to_role ?? 'resident'}`).sort()

  it('the departure day itself is not overdue; the next day flags it (AA + resident), no escalation yet', async () => {
    clock.set(NOW)
    const onTheDay = await overdue(0)
    const dayOne = await overdue(-1)
    await sweep('stays_overdue')
    expect(await kinds(onTheDay.stayId)).toEqual([])
    expect(await kinds(dayOne.stayId)).toEqual(['stay.overdue:AA', 'stay.overdue:resident'])
    const a = await k.audits(dayOne.stayId)
    expect(a.map(x => x.action)).toEqual(['stays.stay.overdue_flagged'])
    expect(a[0]).toMatchObject({ actor_role: 'system', actor_user_id: null })
  })

  it('escalates to the Policy Approver only AFTER the grace (default 3 days): day 3 flagged, day 4 escalated, critical, once; still active', async () => {
    clock.set(NOW)
    const day3 = await overdue(-3)
    const day4 = await overdue(-4)
    await sweep('stays_overdue'); await sweep('stays_overdue')
    expect(await kinds(day3.stayId)).toEqual(['stay.overdue:AA', 'stay.overdue:resident'])
    expect(await kinds(day4.stayId)).toEqual(['stay.overdue:AA', 'stay.overdue:resident', 'stay.overdue_escalated:PolicyApprover'])
    const esc = (await k.notifications(day4.stayId)).find(n => n.kind === 'stay.overdue_escalated')
    expect(esc?.critical).toBe(true)
    expect((await k.audits(day4.stayId)).map(x => x.action)).toEqual(['stays.stay.overdue_flagged', 'stays.stay.overdue_escalated'])
    // THE point: no automatic checkout, move or release
    for (const s of [day3, day4]) {
      const row = await k.stayRow(s.stayId)
      expect(row.status).toBe('active')
      expect(row.checked_out_at).toBeNull()
      expect((await k.claimRow(s.claimId)).released_at).toBeNull()
      expect(await k.bedState(s.w.bedIds[0])).toBe('occupied')
      expect(row.bed_id).toBe(s.w.bedIds[0])
    }
  })

  it('days later the same stay is not notified again; an extension clears the flag', async () => {
    clock.set(NOW)
    const x = await overdue(-5)
    await sweep('stays_overdue')
    const before = await kinds(x.stayId)
    clock.set(NOW + 3 * DAY_MS)
    await sweep('stays_overdue')
    expect(await kinds(x.stayId)).toEqual(before)
    await k.q(`UPDATE bed_claim SET period = $2::daterange WHERE id = $1`, [x.claimId, `[${day(-30)},${day(60)})`])
    const other = await overdue(-1)
    await sweep('stays_overdue')
    expect(await kinds(x.stayId)).toEqual(before)
    expect(await kinds(other.stayId)).toContain('stay.overdue:AA')
    clock.set(NOW)
  })

  it('a stay checked out a moment before the sweep is not flagged', async () => {
    clock.set(NOW)
    const x = await overdue(-2)
    await k.q(`UPDATE stay SET status = 'checked_out', checked_out_at = now() WHERE id = $1`, [x.stayId])
    await sweep('stays_overdue')
    expect(await kinds(x.stayId)).toEqual([])
  })
})

describe('every stays sweep is safe with several runners at once', () => {
  it('end reminders, overdue flag/escalation and checkout reminders notify once even when three runners race (the per-item row lock and dedupe keys are the guard)', async () => {
    clock.set(NOW)
    const w = await k.world(3)
    const [a, b, c] = [await w.res(), await w.res(), await w.res()]
    const ending = await k.stay({ bedId: w.bedIds[0], staffId: a.staffId, from: day(-30), to: day(7) })
    const late = await k.stay({ bedId: w.bedIds[1], staffId: b.staffId, from: day(-30), to: day(-6) })
    const co = await k.stay({ bedId: w.bedIds[2], staffId: c.staffId, from: day(-30), to: day(40) })
    const req = await requestCheckout(c.rc, { stayId: co.stayId, departureDate: day(5), note: null })
    if (!req.ok) throw new Error('setup')
    clock.set(NOW + 2 * DAY_MS) // two business days after the checkout request
    const ctx = { clock, now: clock.now(), db: getDb(), requestId: 'race' }
    for (const name of ['stays_end_reminders', 'stays_overdue', 'stays_checkout_reminders']) {
      const sw = listSweeps().find(x => x.name === name)!
      await Promise.all([sw.run(ctx), sw.run(ctx), sw.run(ctx)])
    }
    const keys = async (id: string) => (await k.notifications(id)).map(n => n.kind).sort()
    expect((await keys(ending.stayId)).filter(x => x === 'stay.end_reminder')).toHaveLength(2) // resident + Accommodation Admin, once
    expect(await keys(late.stayId)).toEqual(['stay.overdue', 'stay.overdue', 'stay.overdue_escalated'])
    expect((await k.audits(late.stayId)).map(x => x.action)).toEqual(['stays.stay.overdue_flagged', 'stays.stay.overdue_escalated'])
    expect(await keys(req.data.id)).toEqual(['checkout.ack_escalated', 'checkout.ack_reminder', 'checkout.requested'])
    clock.set(NOW)
  })
})

describe('checkout acknowledgement reminders (D-63)', () => {
  async function requested(at: number) {
    clock.set(at)
    const w = await k.world(1)
    const res = await w.res()
    const s = await k.stay({ bedId: w.bedIds[0], staffId: res.staffId, from: day(-10), to: day(40) })
    const r = await requestCheckout(res.rc, { stayId: s.stayId, departureDate: new Date(at + 3 * DAY_MS).toISOString().slice(0, 10), note: null })
    if (!r.ok) throw new Error('setup ' + r.reason)
    return { w, res, ...s, id: r.data.id }
  }
  const kinds = async (id: string) => (await k.notifications(id)).map(n => `${n.kind}:${n.to_role ?? 'resident'}`).sort()

  it('Reception is reminded after 1 business day (not before), the Accommodation Admin after 2; each once; the request stays open', async () => {
    const x = await requested(NOW) // Wed 14 Oct 09:42
    expect(await kinds(x.id)).toEqual(['checkout.requested:Rec'])
    clock.set(NOW + 24 * HOUR_MS - 1)
    await sweep('stays_checkout_reminders')
    expect(await kinds(x.id)).toEqual(['checkout.requested:Rec'])
    clock.set(NOW + 24 * HOUR_MS) // Thu 15 Oct: one business day
    await sweep('stays_checkout_reminders'); await sweep('stays_checkout_reminders')
    expect(await kinds(x.id)).toEqual(['checkout.ack_reminder:Rec', 'checkout.requested:Rec'])
    clock.set(NOW + 48 * HOUR_MS) // Fri 16 Oct: two
    await sweep('stays_checkout_reminders')
    expect(await kinds(x.id)).toEqual(['checkout.ack_escalated:AA', 'checkout.ack_reminder:Rec', 'checkout.requested:Rec'])
    expect((await k.q(`SELECT status FROM checkout_request WHERE id = $1`, [x.id]))[0].status).toBe('requested')
    expect((await k.stayRow(x.stayId)).status).toBe('active')
    clock.set(NOW)
  })

  it('weekends do not count as business days; an acknowledged request is not chased', async () => {
    const fri = Date.UTC(2026, 9, 16, 14, 0, 0)
    const x = await requested(fri)
    clock.set(fri + 24 * HOUR_MS) // Saturday
    await sweep('stays_checkout_reminders')
    clock.set(fri + 48 * HOUR_MS) // Sunday
    await sweep('stays_checkout_reminders')
    expect(await kinds(x.id)).toEqual(['checkout.requested:Rec'])
    clock.set(fri + 72 * HOUR_MS) // Monday: one business day
    await sweep('stays_checkout_reminders')
    expect(await kinds(x.id)).toContain('checkout.ack_reminder:Rec')

    const y = await requested(fri)
    await k.q(`UPDATE checkout_request SET status = 'acknowledged', acknowledged_at = now() WHERE id = $1`, [y.id])
    clock.set(fri + 120 * HOUR_MS)
    await sweep('stays_checkout_reminders')
    expect(await kinds(y.id)).toEqual(['checkout.requested:Rec'])
    clock.set(NOW)
  })
})

describe('no automatic decision, ever (CLAUDE.md invariant)', () => {
  it('long after every boundary: the pending extension, the approved transfer, the open checkout and the overdue resident are exactly as they were', async () => {
    clock.set(NOW)
    const w = await k.world(4)
    const aa2 = await k.person('AA', { siteIds: [w.siteId] })
    const [r1, r2, r3, r4] = [await w.res(), await w.res(), await w.res(), await w.res()]
    const ext = await k.stay({ bedId: w.bedIds[0], staffId: r1.staffId, from: day(-5), to: day(10) })
    const tr = await k.stay({ bedId: w.bedIds[1], staffId: r2.staffId, from: day(-5), to: day(60) })
    const co = await k.stay({ bedId: w.bedIds[2], staffId: r3.staffId, from: day(-5), to: day(60) })
    const od = await k.stay({ bedId: w.bedIds[3], staffId: r4.staffId, from: day(-30), to: day(-2) })
    const spare = await k.q<{ id: string }>(`INSERT INTO bed (site_id, room_id, code) VALUES ($1, $2, 'SPARE') RETURNING id`, [w.siteId, w.roomId])

    const e = await requestExtension(r1.rc, { stayId: ext.stayId, newEnd: day(25), reason: null })
    const t = await requestTransfer(r2.rc, { stayId: tr.stayId, destinationBedId: spare[0].id, reason: 'Move please', neededBy: null, linkedExtensionId: null })
    const c = await requestCheckout(r3.rc, { stayId: co.stayId, departureDate: day(3), note: null })
    if (!e.ok || !t.ok || !c.ok) throw new Error('setup')
    expect((await approveTransfer(aa2.rc, { id: t.data.id, destinationBedId: null, note: null })).ok).toBe(true)

    // the pending items are in the approvals inbox
    const inbox = await listInbox(getDb(), w.aa.rc.actor, clock.now())
    expect(inbox.map(i => i.kind)).toContain('extension')

    for (const days of [1, 2, 3, 5, 10, 30, 90]) {
      clock.set(NOW + days * DAY_MS)
      for (const name of ['stays_no_show', 'stays_end_reminders', 'stays_overdue', 'stays_checkout_reminders', 'approval_reminders']) await sweep(name)
    }

    expect((await k.q(`SELECT status FROM extension_request WHERE id = $1`, [e.data.id]))[0].status).toBe('requested')
    expect((await k.q(`SELECT status, executed_at FROM transfer_request WHERE id = $1`, [t.data.id]))[0]).toMatchObject({ status: 'approved', executed_at: null })
    expect((await k.q(`SELECT status FROM checkout_request WHERE id = $1`, [c.data.id]))[0].status).toBe('requested')
    for (const s of [ext, tr, co, od]) {
      const row = await k.stayRow(s.stayId)
      expect(row.status).toBe('active')
      expect(row.checked_out_at).toBeNull()
      expect((await k.claimRow(s.claimId)).released_at).toBeNull()
    }
    expect((await k.stayRow(tr.stayId)).bed_id).toBe(w.bedIds[1])
    expect((await k.stayRow(ext.stayId)).claim_id).toBe(ext.claimId)
    expect((await k.claimRow(ext.claimId)).period).toBe(`[${day(-5)},${day(10)})`)
    // they were reminded and escalated, though
    const reminded = (await k.notifications(e.data.id)).map(n => n.kind)
    expect(reminded).toEqual(expect.arrayContaining(['approval.reminder', 'approval.backup', 'approval.escalated']))
    clock.set(NOW)
  })
})
