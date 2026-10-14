/**
 * Waitlist and offer timers. Every test lives in its own window of the distant past (see helpers.ts) because sweeps are global.
 * For each boundary: just before, just after, run twice, run at the same instant, and "nothing was decided for a person".
 */
import { afterAll, describe, expect, it } from 'vitest'
import { admin, closeAll } from '../harness'
import { mkRequest, mkStaff } from '../fixtures2'
import { audits, claimRow, entryRow, notes, offerRow, person, reservationCount, window, world, HOUR, DAY } from './helpers'
import { runCommand } from '@/server/command/run'
import { allocateBed } from '@/server/allocation'
import { runSweep } from '@/server/jobs/registry'
import '@/server/jobs/sweeps'
import { addToWaitlist } from '@/server/commands/waitlist/add'
import { createOffer } from '@/server/commands/waitlist/offer'
import { confirmDelivery, viewOffer } from '@/server/commands/waitlist/delivery'
import { renewEntry } from '@/server/commands/waitlist/renew'
import { acceptOffer, declineOffer } from '@/server/commands/waitlist/respond'

afterAll(closeAll)

type World = Awaited<ReturnType<typeof world>>
type Win = ReturnType<typeof window>

async function scene(o: { withRequest?: boolean } = {}) {
  const w = await world({ beds: 3 })
  const win = window({ sweeps: true })
  const requestId = o.withRequest ? await mkRequest({ staffId: w.res.staffId, siteId: w.siteId, arrival: win.day(5), end: win.day(65), status: 'pending_approval' }) : undefined
  const e = await addToWaitlist(w.rec.rc(win.clock), { staffId: w.res.staffId, siteId: w.siteId, requestId, arrival: win.day(5), end: win.day(65) })
  if (!e.ok) throw new Error(e.reason)
  return { w, win, entryId: e.data.entryId, requestId, created: win.clock.nowMs() }
}
async function another(w: World, win: Win) {
  win.clock.advance(HOUR)
  const r = await person('Res')
  const e = await addToWaitlist(w.rec.rc(win.clock), { staffId: r.staffId, siteId: w.siteId, arrival: win.day(5), end: win.day(65) })
  if (!e.ok) throw new Error(e.reason)
  return { r, entryId: e.data.entryId }
}
async function offer(w: World, win: Win, entryId: string, bedId: string) {
  const r = await createOffer(w.aa.rc(win.clock), { entryId, bedId })
  if (!r.ok) throw new Error(r.reason)
  return r.data
}
const sweep = (name: string, win: Win) => runSweep(name, win.clock)
const at = (win: Win, ms: number) => { win.clock.set(ms) }
const canAllocate = (w: World, win: Win, bedId: string, from: string, to: string) =>
  runCommand(w.aa.rc(win.clock), async c => allocateBed(c, { bedId, staffId: (await mkStaff()).id, from, to, kind: 'reservation' }))
const count = async (prefix: string) => (await notes(prefix)).length

describe('AT-010 waitlist expiry', () => {
  it('stays open until the 15th day, then closes with reason "expired"; reminder history remains; the resident is notified; a stale offer hold is released', async () => {
    const { w, win, entryId, requestId, created } = await scene({ withRequest: true })
    const o = await offer(w, win, entryId, w.bedIds[0]) // never delivered: a stale hold
    const expires = created + 15 * DAY

    at(win, expires - 3 * DAY); await sweep('waitlist_expiry', win)   // 3-day reminder
    at(win, expires - 1 * DAY); await sweep('waitlist_expiry', win)   // 1-day reminder
    expect((await entryRow(entryId)).reminders_sent).toEqual([3, 1])

    at(win, expires - 1000); await sweep('waitlist_expiry', win)
    expect(await entryRow(entryId)).toMatchObject({ status: 'offered', close_reason: null })   // a second before: still open
    expect((await offerRow(o.offerId)).status).toBe('pending')
    expect((await claimRow(o.claimId)).released_at).toBeNull()

    at(win, expires); const out = await sweep('waitlist_expiry', win)
    expect(out.ok).toBe(true)
    const e = await entryRow(entryId)
    expect(e).toMatchObject({ status: 'closed', close_reason: 'expired', reminders_sent: [3, 1] })
    expect((await offerRow(o.offerId)).status).toBe('expired')
    expect(await claimRow(o.claimId)).toMatchObject({ release_reason: 'offer_expired' })
    expect((await claimRow(o.claimId)).released_at).not.toBeNull()
    expect((await canAllocate(w, win, w.bedIds[0], win.day(5), win.day(9))).ok).toBe(true)  // the bed is free again

    const n = await notes(`waitlist:${entryId}:expired`)
    expect(n.find(x => x.dedupe_key === `waitlist:${entryId}:expired`)).toMatchObject({ to_staff_id: w.res.staffId })
    expect(n.find(x => x.dedupe_key === `waitlist:${entryId}:expired:admin`)).toMatchObject({ to_role: 'AA', site_id: w.siteId })
    expect((await audits(entryId)).find(a => a.action === 'waitlist.entry.expired')).toMatchObject({ actor_role: 'system', actor_user_id: null })
    // the linked request is closed (not rejected, not approved); nobody got a bed
    expect((await admin().query(`SELECT status FROM accommodation_request WHERE id = $1`, [requestId])).rows[0].status).toBe('closed')
    expect(await reservationCount(w.res.staffId)).toBe(0)
  })

  it('AT-030 running it again, or twice at the same instant, does the thing once', async () => {
    const { w, win, entryId, created } = await scene()
    const o = await offer(w, win, entryId, w.bedIds[0])
    at(win, created + 15 * DAY + HOUR)
    const runs = await Promise.all([sweep('waitlist_expiry', win), sweep('waitlist_expiry', win)])
    expect(runs.filter(r => r.skipped)).toHaveLength(1) // one runner at a time
    await sweep('waitlist_expiry', win)
    await sweep('waitlist_expiry', win)
    expect(await count(`waitlist:${entryId}:expired`)).toBe(2) // resident + Accommodation Admin, once each
    expect(await count(`offer:${o.offerId}:expired`)).toBe(1)
    expect((await audits(entryId)).filter(a => a.action === 'waitlist.entry.expired')).toHaveLength(1)
    expect((await entryRow(entryId)).status).toBe('closed')
  })

  it('reminders at 3 and 1 days: not before, each exactly once, to the resident and the Accommodation Admin; they decide nothing', async () => {
    const { w, win, entryId, created } = await scene()
    const expires = created + 15 * DAY
    const key = (d: number) => `waitlist:${entryId}:c0:reminder:${d}`

    at(win, expires - 3 * DAY - 1000); await sweep('waitlist_expiry', win)
    expect((await entryRow(entryId)).reminders_sent).toEqual([])
    expect(await count(`waitlist:${entryId}:c0`)).toBe(0)

    at(win, expires - 3 * DAY); await sweep('waitlist_expiry', win); await sweep('waitlist_expiry', win)
    expect((await entryRow(entryId)).reminders_sent).toEqual([3])
    const first = await notes(key(3))
    expect(first.map(x => x.dedupe_key).sort()).toEqual([key(3), `${key(3)}:admin`])
    expect(first.find(x => x.dedupe_key === key(3))).toMatchObject({ to_staff_id: w.res.staffId })
    expect(first.find(x => x.dedupe_key === key(3))!.text).toMatch(/ends in 3 days/)
    expect(first.find(x => x.dedupe_key === `${key(3)}:admin`)).toMatchObject({ to_role: 'AA', site_id: w.siteId })

    at(win, expires - 1 * DAY - 1000); await sweep('waitlist_expiry', win)
    expect(await count(key(1))).toBe(0)
    at(win, expires - 1 * DAY); await sweep('waitlist_expiry', win); await sweep('waitlist_expiry', win)
    expect((await entryRow(entryId)).reminders_sent).toEqual([3, 1])
    expect(await count(key(1))).toBe(2)
    expect(await count(key(3))).toBe(2)

    // nothing was decided: still waiting, same place, no offer, no reservation
    expect(await entryRow(entryId)).toMatchObject({ status: 'waiting', declines: 0, close_reason: null })
    expect(await reservationCount(w.res.staffId)).toBe(0)
  })

  it('a late first sweep sends one reminder (the most urgent) and records every point passed', async () => {
    const { win, entryId, created } = await scene()
    at(win, created + 15 * DAY - 12 * HOUR); await sweep('waitlist_expiry', win)
    expect((await entryRow(entryId)).reminders_sent).toEqual([3, 1])
    expect(await count(`waitlist:${entryId}:c0:reminder:1`)).toBe(2)
    expect(await count(`waitlist:${entryId}:c0:reminder:3`)).toBe(0)
  })

  it('renewal before expiry keeps the entry alive; the new cycle is reminded again and the old expiry no longer applies', async () => {
    const { w, win, entryId, created } = await scene()
    at(win, created + 13 * DAY); await sweep('waitlist_expiry', win)           // 2 days left: the 3-day reminder is due
    expect((await entryRow(entryId)).reminders_sent).toEqual([3])
    expect((await renewEntry(w.aa.rc(win.clock), { entryId })).ok).toBe(true)
    at(win, created + 16 * DAY); await sweep('waitlist_expiry', win)           // past the OLD expiry: still open
    expect((await entryRow(entryId)).status).toBe('waiting')
    at(win, created + 13 * DAY + 12 * DAY); await sweep('waitlist_expiry', win) // 3 days before the NEW expiry
    expect((await entryRow(entryId)).reminders_sent).toEqual([3])
    expect(await count(`waitlist:${entryId}:c1:reminder:3`)).toBe(2)
    at(win, created + 13 * DAY + 15 * DAY); await sweep('waitlist_expiry', win)
    expect(await entryRow(entryId)).toMatchObject({ status: 'closed', close_reason: 'expired' })
  })

  it('an entry that is accepted or left before expiry is not expired or reminded', async () => {
    const { w, win, entryId, created } = await scene()
    const o = await offer(w, win, entryId, w.bedIds[0])
    await viewOffer(w.res.rc(win.clock), { offerId: o.offerId })
    expect((await acceptOffer(w.res.rc(win.clock), { offerId: o.offerId })).ok).toBe(true)
    at(win, created + 14 * DAY); await sweep('waitlist_expiry', win)
    at(win, created + 20 * DAY); await sweep('waitlist_expiry', win)
    expect(await entryRow(entryId)).toMatchObject({ status: 'closed', close_reason: 'offer_accepted', reminders_sent: [] })
    expect(await count(`waitlist:${entryId}:expired`)).toBe(0)
    expect(await reservationCount(w.res.staffId)).toBe(1) // the reservation is untouched
  })
})

describe('AT-011 bed offer timer', () => {
  it('48 hours after CONFIRMED delivery with no answer: the offer expires, the hold releases, the place is kept, and the Accommodation Admin is told who is next (no automatic offer)', async () => {
    const { w, win, entryId } = await scene()
    const behind = await another(w, win)
    const queueTs = (await entryRow(entryId)).queue_ts.getTime()
    const o = await offer(w, win, entryId, w.bedIds[0])
    win.clock.advance(5 * HOUR)
    await viewOffer(w.res.rc(win.clock), { offerId: o.offerId })
    const delivered = win.clock.nowMs()
    expect((await offerRow(o.offerId)).expires_at?.getTime()).toBe(delivered + 48 * HOUR)

    at(win, delivered + 48 * HOUR - 1000); await sweep('waitlist_offer_expiry', win)
    expect((await offerRow(o.offerId)).status).toBe('pending')
    expect((await canAllocate(w, win, w.bedIds[0], win.day(5), win.day(9))).ok).toBe(false) // still held

    at(win, delivered + 48 * HOUR); await sweep('waitlist_offer_expiry', win)
    expect(await offerRow(o.offerId)).toMatchObject({ status: 'expired' })
    expect(await claimRow(o.claimId)).toMatchObject({ release_reason: 'offer_expired' })
    const e = await entryRow(entryId)
    expect(e).toMatchObject({ status: 'waiting', declines: 0, skip_bed_ids: [w.bedIds[0]] })     // not a decline; place kept
    expect(e.queue_ts.getTime()).toBe(queueTs)
    expect((await canAllocate(w, win, w.bedIds[0], win.day(5), win.day(9))).ok).toBe(true)

    // queue updated: the resident is still first; the person behind would be next for another bed. The Accommodation Admin hears about the freed bed
    const n = await notes(`offer:${o.offerId}:expired`)
    expect(n.find(x => x.dedupe_key === `offer:${o.offerId}:expired`)).toMatchObject({ to_staff_id: w.res.staffId })
    const freed = await notes(`waitlist:bed:${w.bedIds[0]}:offer:${o.offerId}:expired`)
    expect(freed).toHaveLength(1)
    expect(freed[0]).toMatchObject({ to_role: 'AA', site_id: w.siteId })
    expect(freed[0].text).toContain('Next in the waitlist queue')
    // ...but no offer was created for anybody
    const offers = (await admin().query(`SELECT count(*)::int AS n FROM bed_offer WHERE staff_id = ANY($1)`, [[w.res.staffId, behind.r.staffId]])).rows[0].n
    expect(offers).toBe(1)
    expect((await audits(o.offerId)).find(a => a.action === 'waitlist.offer.expired')).toMatchObject({ actor_role: 'system' })
    expect(await reservationCount(w.res.staffId)).toBe(0)
    expect(await reservationCount(behind.r.staffId)).toBe(0)
  })

  it('an undelivered offer never expires by itself (delivery cannot be confirmed: alert staff, do not silently expire)', async () => {
    const { w, win, entryId } = await scene()
    const o = await offer(w, win, entryId, w.bedIds[0])
    at(win, win.clock.nowMs() + 10 * DAY); await sweep('waitlist_offer_expiry', win)
    expect((await offerRow(o.offerId)).status).toBe('pending')
    expect((await entryRow(entryId)).status).toBe('offered')
  })

  it('the window runs from the confirmed delivery, whichever way it was confirmed (offline here), not from the offer', async () => {
    const { w, win, entryId } = await scene()
    const o = await offer(w, win, entryId, w.bedIds[0])
    win.clock.advance(30 * HOUR)
    expect((await confirmDelivery(w.rec.rc(win.clock), { offerId: o.offerId, via: 'offline', note: 'told at the desk' })).ok).toBe(true)
    const delivered = win.clock.nowMs()
    at(win, delivered - 30 * HOUR + 48 * HOUR); await sweep('waitlist_offer_expiry', win) // 48 h after CREATION: not expired
    expect((await offerRow(o.offerId)).status).toBe('pending')
    at(win, delivered + 48 * HOUR - 1000); await sweep('waitlist_offer_expiry', win)
    expect((await offerRow(o.offerId)).status).toBe('pending')
    at(win, delivered + 48 * HOUR); await sweep('waitlist_offer_expiry', win)
    expect((await offerRow(o.offerId)).status).toBe('expired')
  })

  it('AT-030 twice and at once: expires once, notifies once; an offer answered before the boundary is not expired', async () => {
    const a = await scene()
    const o = await offer(a.w, a.win, a.entryId, a.w.bedIds[0])
    await viewOffer(a.w.res.rc(a.win.clock), { offerId: o.offerId })
    at(a.win, a.win.clock.nowMs() + 49 * HOUR)
    const runs = await Promise.all([sweep('waitlist_offer_expiry', a.win), sweep('waitlist_offer_expiry', a.win)])
    expect(runs.filter(r => r.skipped)).toHaveLength(1)
    await sweep('waitlist_offer_expiry', a.win)
    expect(await count(`offer:${o.offerId}:expired`)).toBe(1) // the resident, once (nobody else is waiting, so there is no "next in queue" hint)
    expect((await audits(o.offerId)).filter(x => x.action === 'waitlist.offer.expired')).toHaveLength(1)

    const b = await scene()
    const o2 = await offer(b.w, b.win, b.entryId, b.w.bedIds[0])
    await viewOffer(b.w.res.rc(b.win.clock), { offerId: o2.offerId })
    b.win.clock.advance(47 * HOUR)
    expect((await acceptOffer(b.w.res.rc(b.win.clock), { offerId: o2.offerId })).ok).toBe(true)
    at(b.win, b.win.clock.nowMs() + 5 * DAY); await sweep('waitlist_offer_expiry', b.win)
    expect((await offerRow(o2.offerId)).status).toBe('accepted')
    expect((await claimRow(o2.claimId)).kind).toBe('reservation')
    expect((await claimRow(o2.claimId)).released_at).toBeNull()
  })

  it('a decline racing the sweep at the boundary: exactly one outcome, the bed ends up free and the place is consistent', async () => {
    const { w, win, entryId } = await scene()
    const o = await offer(w, win, entryId, w.bedIds[0])
    await viewOffer(w.res.rc(win.clock), { offerId: o.offerId })
    const expiry = win.clock.nowMs() + 48 * HOUR
    at(win, expiry - 1)
    const [d] = await Promise.all([declineOffer(w.res.rc(win.clock), { offerId: o.offerId }), sweep('waitlist_offer_expiry', win)])
    expect(d.ok).toBe(true)                         // one millisecond before the end: the decline is on time
    expect((await offerRow(o.offerId)).status).toBe('declined')
    at(win, expiry + 1); await sweep('waitlist_offer_expiry', win)
    expect((await offerRow(o.offerId)).status).toBe('declined') // the sweep does not overwrite an answer
    expect(await entryRow(entryId)).toMatchObject({ status: 'waiting', declines: 1 })
    expect((await claimRow(o.claimId)).released_at).not.toBeNull()
  })
})

describe('unseen follow-up (D-52): not viewed within 24 hours, Reception informs the resident', () => {
  it('24 hours after the offer was made with no confirmed delivery, Reception is alerted once; nothing else changes', async () => {
    const { w, win, entryId } = await scene()
    const o = await offer(w, win, entryId, w.bedIds[0])
    const made = win.clock.nowMs()
    at(win, made + 24 * HOUR - 1000); await sweep('waitlist_offer_followup', win)
    expect((await offerRow(o.offerId)).follow_up_sent_at).toBeNull()
    expect(await count(`offer:${o.offerId}:followup`)).toBe(0)

    at(win, made + 24 * HOUR); await sweep('waitlist_offer_followup', win)
    await sweep('waitlist_offer_followup', win)
    const [a, b] = await Promise.all([sweep('waitlist_offer_followup', win), sweep('waitlist_offer_followup', win)])
    expect([a.skipped, b.skipped].filter(Boolean).length).toBeLessThanOrEqual(1)
    const row = await offerRow(o.offerId)
    expect(row.follow_up_sent_at?.getTime()).toBe(made + 24 * HOUR)
    const n = await notes(`offer:${o.offerId}:followup`)
    expect(n).toHaveLength(1)
    expect(n[0]).toMatchObject({ to_role: 'Rec', site_id: w.siteId, kind: 'offer.follow_up' })
    expect(n[0].text).toMatch(/informed offline/)
    // still pending, still held, still no timer: it was not decided or expired
    expect(row).toMatchObject({ status: 'pending', delivered_at: null, expires_at: null })
    expect((await claimRow(o.claimId)).released_at).toBeNull()
    expect((await audits(o.offerId)).filter(x => x.action === 'waitlist.offer.follow_up')).toHaveLength(1)
    // Reception then records it, which starts the 48 hours
    expect((await confirmDelivery(w.rec.rc(win.clock), { offerId: o.offerId, via: 'offline', note: 'Phoned, will answer tomorrow' })).ok).toBe(true)
    expect((await offerRow(o.offerId)).expires_at?.getTime()).toBe(win.clock.nowMs() + 48 * HOUR)
  })

  it('no follow-up for an offer that was seen (or recorded) in time', async () => {
    const a = await scene()
    const o = await offer(a.w, a.win, a.entryId, a.w.bedIds[0])
    a.win.clock.advance(23 * HOUR)
    await viewOffer(a.w.res.rc(a.win.clock), { offerId: o.offerId })
    at(a.win, a.win.clock.nowMs() + 2 * HOUR); await sweep('waitlist_offer_followup', a.win)
    expect(await count(`offer:${o.offerId}:followup`)).toBe(0)
    const b = await scene()
    const o2 = await offer(b.w, b.win, b.entryId, b.w.bedIds[0])
    b.win.clock.advance(20 * HOUR)
    await confirmDelivery(b.w.rec.rc(b.win.clock), { offerId: o2.offerId, via: 'offline', note: 'told in person' })
    at(b.win, b.win.clock.nowMs() + 10 * HOUR); await sweep('waitlist_offer_followup', b.win)
    expect(await count(`offer:${o2.offerId}:followup`)).toBe(0)
  })
})

describe('nothing is decided by the passing of time', () => {
  it('after every sweep and a long wait: no reservation, no new offer, no request approved or rejected, no one moved, no one auto-offered', async () => {
    const { w, win, entryId, requestId } = await scene({ withRequest: true })
    const behind = await another(w, win)
    const before = await entryRow(behind.entryId)
    // the entry at the head is offered a bed and does not answer; the one behind waits
    const o = await offer(w, win, entryId, w.bedIds[0])
    for (const days of [1, 2, 5, 14]) {
      at(win, win.clock.nowMs() + days * DAY)
      for (const name of ['waitlist_expiry', 'waitlist_offer_expiry', 'waitlist_offer_followup', 'approval_reminders']) await sweep(name, win)
    }
    // the second person's entry expired (15 days), the first person's offer lapsed with it; nobody was given a bed
    expect((await entryRow(entryId)).status).toBe('closed')
    expect((await offerRow(o.offerId)).status).toBe('expired')
    expect(await reservationCount(w.res.staffId)).toBe(0)
    expect(await reservationCount(behind.r.staffId)).toBe(0)
    expect((await admin().query(`SELECT count(*)::int AS n FROM bed_offer WHERE staff_id = $1`, [behind.r.staffId])).rows[0].n).toBe(0)
    expect((await admin().query(`SELECT status, decided_by FROM accommodation_request WHERE id = $1`, [requestId])).rows[0]).toEqual({ status: 'closed', decided_by: null })
    expect(before.status).toBe('waiting')
    expect((await admin().query(`SELECT count(*)::int AS n FROM stay WHERE staff_id = ANY($1)`, [[w.res.staffId, behind.r.staffId]])).rows[0].n).toBe(0)
  })

  it('an entry with an offer still inside its window, and live, is untouched by any sweep before its time', async () => {
    const { w, win, entryId } = await scene()
    const o = await offer(w, win, entryId, w.bedIds[0])
    await viewOffer(w.res.rc(win.clock), { offerId: o.offerId })
    for (const name of ['waitlist_expiry', 'waitlist_offer_expiry', 'waitlist_offer_followup']) await sweep(name, win)
    at(win, win.clock.nowMs() + 47 * HOUR)
    for (const name of ['waitlist_expiry', 'waitlist_offer_expiry', 'waitlist_offer_followup']) await sweep(name, win)
    expect(await offerRow(o.offerId)).toMatchObject({ status: 'pending' })
    expect(await entryRow(entryId)).toMatchObject({ status: 'offered', declines: 0 })
    expect((await claimRow(o.claimId)).kind).toBe('offer_hold')
  })
})
