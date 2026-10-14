/**
 * Hardening round, WP-N, S-22 (AT-037): the OTHER states of P-13 (proposed, pending client sign-off), in a PRIVATE database because they
 * change a global setting and run every sweep (the shared test database is used by every test file at once):
 *   readiness.offer_lead_days = 0   no restriction (the behaviour before the proposal)
 *   readiness.offer_lead_days = 3   a longer lead time moves the boundary
 * and the guarantee that acceptance and the sweeps never turn a bed that is not ready into a checked-in stay.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createIsolated } from '../access/isolated'
import { FixedClock } from '@/server/clock'
import { DAY_MS, NOW, day, kit } from '../stays/iso'
import { listSweeps, runSweep } from '@/server/jobs/registry'
import '@/server/jobs/sweeps'
import { addToWaitlist } from '@/server/commands/waitlist/add'
import { createOffer, offerToNext } from '@/server/commands/waitlist/offer'
import { acceptOffer } from '@/server/commands/waitlist/respond'
import { checkIn } from '@/server/commands/stays/checkIn'
import { getDb } from '@/server/db/client'
import { matchFreedBed } from '@/server/commands/waitlist/queue'

const iso = await createIsolated()
afterAll(() => iso.close())
const clock = new FixedClock(NOW)
const k = kit(iso, clock)
beforeEach(() => { clock.set(NOW) })

const setting = (key: string, value: unknown) => k.q(
  `INSERT INTO config_item (key, scope_site_id, version, value) VALUES ($1, NULL, COALESCE((SELECT max(version) FROM config_item WHERE key = $1 AND scope_site_id IS NULL), 0) + 1, $2::jsonb)`, [key, JSON.stringify(value)])
/** Along legal transitions only: Available -> Occupied -> Needs cleaning (-> Inspection required). */
async function notReady(bedId: string, state: 'needs_cleaning' | 'inspection_required') {
  await k.q(`UPDATE bed SET state = 'occupied' WHERE id = $1`, [bedId])
  await k.q(`UPDATE bed SET state = 'needs_cleaning' WHERE id = $1`, [bedId])
  if (state === 'inspection_required') await k.q(`UPDATE bed SET state = 'inspection_required' WHERE id = $1`, [bedId])
}
async function rig(state: 'available' | 'needs_cleaning' | 'inspection_required' | 'blocked', startInDays: number) {
  const w = await k.world(1)
  const staff = await w.res()
  if (state === 'blocked') await k.q(`UPDATE bed SET state = 'blocked' WHERE id = $1`, [w.bedIds[0]])
  else if (state !== 'available') await notReady(w.bedIds[0], state)
  const wl = await addToWaitlist(w.rec.rc, { staffId: staff.staffId, siteId: w.siteId, arrival: day(startInDays), end: day(startInDays + 30) })
  if (!wl.ok) throw new Error('waitlist: ' + wl.reason)
  return { ...w, staff, bedId: w.bedIds[0], entryId: wl.data.entryId }
}
const holds = async (bedId: string) => (await k.q(`SELECT 1 FROM bed_claim WHERE bed_id = $1 AND released_at IS NULL AND kind = 'offer_hold'`, [bedId])).length

describe('AT-037 P-13 (proposed, pending client sign-off) with readiness.offer_lead_days = 0: no restriction, the behaviour before the proposal', () => {
  it('a bed that needs cleaning or waits for inspection can be offered for today, through both entry points; a blocked bed is still refused (allocateBed, for every date); check-in is still gated', async () => {
    await setting('readiness.offer_lead_days', 0)
    for (const state of ['needs_cleaning', 'inspection_required'] as const) {
      const r = await rig(state, 0)
      const out = await createOffer(r.aa.rc, { entryId: r.entryId, bedId: r.bedId })
      expect(out.ok, `${state}: ${JSON.stringify(out)}`).toBe(true)
      expect(await holds(r.bedId)).toBe(1)
      const viaNext = await rig(state, 0)
      expect((await offerToNext(viaNext.aa.rc, { bedId: viaNext.bedId })).ok, state).toBe(true)
      // the match carries no readiness warning when nothing restricts it
      const free = await rig(state, 0)
      expect((await matchFreedBed(getDb(), free.bedId, new Date(NOW)))?.notReady).toBeUndefined()
    }
    const blocked = await rig('blocked', 3)
    const refused = await createOffer(blocked.aa.rc, { entryId: blocked.entryId, bedId: blocked.bedId })
    expect(!refused.ok && refused.detail).toMatchObject({ reason: 'bed_unavailable' })

    // check-in keeps its own gate whatever the setting says
    const w = await k.world(1)
    const guest = await w.res()
    const rv = await k.reservation({ bedId: w.bedIds[0], staffId: guest.staffId, from: day(0), to: day(10) })
    await notReady(w.bedIds[0], 'needs_cleaning')
    const ci = await checkIn(w.rec.rc, { reservationId: rv.reservationId })
    expect(!ci.ok && ci.detail).toMatchObject({ reason: 'bed_not_ready', state: 'needs_cleaning' })
    await setting('readiness.offer_lead_days', 1)
  })
})

describe('AT-037 P-13 (proposed, pending client sign-off) with a longer lead time: the boundary moves with the setting', () => {
  it('lead 3: a bed that is not ready is refused for a start today, tomorrow and the day after, and accepted from day 3; the refusal names the earliest date', async () => {
    await setting('readiness.offer_lead_days', 3)
    for (const [n, allowed] of [[0, false], [1, false], [2, false], [3, true], [4, true]] as const) {
      const r = await rig('needs_cleaning', n)
      const out = await createOffer(r.aa.rc, { entryId: r.entryId, bedId: r.bedId })
      if (allowed) { expect(out.ok, `day ${n}: ${JSON.stringify(out)}`).toBe(true); continue }
      expect(out.ok).toBe(false)
      expect(!out.ok && out.detail).toMatchObject({ reason: 'bed_not_ready', from: day(n), earliest: day(3), leadDays: 3 })
      expect(!out.ok && out.reason).toMatch(/3 days from today/)
      expect(await holds(r.bedId)).toBe(0)
    }
    // a bed that is Available is never restricted by the lead time
    const ready = await rig('available', 0)
    expect((await createOffer(ready.aa.rc, { entryId: ready.entryId, bedId: ready.bedId })).ok).toBe(true)
    await setting('readiness.offer_lead_days', 1)
  })

  it('the day is the SITE\'s day: in a time zone far ahead of UTC "today" is already tomorrow there', async () => {
    await setting('readiness.offer_lead_days', 1)
    const w = await k.world(1)
    await k.q(`UPDATE site SET time_zone = 'Pacific/Auckland' WHERE id = $1`, [w.siteId]) // UTC+13 in October: 09:42 UTC on the 14th is 22:42 on the 14th there... and the 15th a little later
    const staff = await w.res()
    await notReady(w.bedIds[0], 'needs_cleaning')
    clock.set(Date.UTC(2026, 9, 14, 12, 0, 0)) // 01:00 on the 15th in Auckland
    const wl = await addToWaitlist(w.rec.rc, { staffId: staff.staffId, siteId: w.siteId, arrival: day(1), end: day(30) }) // the 15th: that is TODAY there
    if (!wl.ok) throw new Error(wl.reason)
    const out = await createOffer(w.aa.rc, { entryId: wl.data.entryId, bedId: w.bedIds[0] })
    expect(!out.ok && out.detail).toMatchObject({ reason: 'bed_not_ready', from: day(1), earliest: day(2) })
  })
})

describe('AT-037 acceptance and the sweeps never turn a bed that is not ready into a checked-in stay', () => {
  it('an offer for tomorrow on a bed that needs cleaning is accepted into a reservation; every sweep, run through and beyond the arrival day, creates no stay and does not move the bed; check-in stays refused until a passed inspection', async () => {
    await setting('readiness.offer_lead_days', 1)
    const w = await k.world(1)
    const account = await w.res()
    await notReady(w.bedIds[0], 'needs_cleaning')
    const wl = await addToWaitlist(w.rec.rc, { staffId: account.staffId, siteId: w.siteId, arrival: day(1), end: day(30) })
    if (!wl.ok) throw new Error(wl.reason)
    const offered = await createOffer(w.aa.rc, { entryId: wl.data.entryId, bedId: w.bedIds[0] })
    expect(offered.ok, JSON.stringify(offered)).toBe(true)
    const offerId = (await k.q<{ id: string }>(`SELECT id FROM bed_offer WHERE bed_id = $1`, [w.bedIds[0]]))[0].id
    const accepted = await acceptOffer(account.rc, { offerId })
    expect(accepted.ok, JSON.stringify(accepted)).toBe(true)
    const reservationId = (await k.q<{ id: string }>(`SELECT id FROM reservation WHERE staff_id = $1`, [account.staffId]))[0].id

    // every registered sweep, every six hours until the arrival day is under way (before the no-show deadline of 24 h after the planned arrival)
    const names = listSweeps().map(s => s.name)
    expect(names.length).toBeGreaterThan(5)
    for (let h = 0; h <= 48; h += 6) {
      clock.set(NOW + h * 3_600_000)
      for (const name of names) await runSweep(name, clock)
    }
    expect(await k.q(`SELECT 1 FROM stay WHERE staff_id = $1`, [account.staffId])).toHaveLength(0)
    expect(await k.bedState(w.bedIds[0])).toBe('needs_cleaning')

    // the arrival day is here (day 2 by now): check-in is refused by the readiness rule, with reason, owner and next action
    expect((await k.q<{ status: string }>(`SELECT status FROM reservation WHERE id = $1`, [reservationId]))[0].status).toBe('reserved')
    clock.set(NOW + 47 * 3_600_000)
    const blocked = await checkIn(w.rec.rc, { reservationId })
    expect(blocked.ok).toBe(false)
    expect(!blocked.ok && blocked.detail).toMatchObject({ reason: 'bed_not_ready', state: 'needs_cleaning' })
    expect(!blocked.ok && blocked.owner).toMatch(/Housekeeping/)
    expect(!blocked.ok && blocked.next).toBeTruthy()
    expect(await k.q(`SELECT 1 FROM stay WHERE staff_id = $1`, [account.staffId])).toHaveLength(0)

    // past the no-show deadline the sweep may let the reservation lapse (it releases a hold, it never checks anyone in)
    for (let h = 48; h <= 96; h += 6) {
      clock.set(NOW + h * 3_600_000)
      for (const name of names) await runSweep(name, clock)
    }
    expect((await k.q<{ status: string }>(`SELECT status FROM reservation WHERE id = $1`, [reservationId]))[0].status).not.toBe('checked_in')
    expect(await k.q(`SELECT 1 FROM stay WHERE staff_id = $1`, [account.staffId])).toHaveLength(0)
    expect(await k.bedState(w.bedIds[0])).toBe('needs_cleaning')
  })
})
