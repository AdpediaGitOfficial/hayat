import { afterAll, describe, expect, it } from 'vitest'
import { admin, closeAll, makeUser } from '../harness'
import { day, liveClaims, mkBed, mkException, mkProperty, mkRoom, mkSite, mkStaff, occupy, reserve, setConfigValue, setState } from '../fixtures2'
import { rcFor } from '../rc'
import { runCommand } from '@/server/command/run'
import { FixedClock } from '@/server/clock'
import { allocateBed, convertClaim, releaseClaim, suggestBeds, type AllocateInput } from '@/server/allocation'
import { getDb } from '@/server/db/client'

afterAll(closeAll)

const clock = new FixedClock(Date.UTC(2026, 9, 14, 9, 0, 0))
async function adminRc() {
  const u = await makeUser({ roles: [{ role: 'SA', all: true }] })
  return rcFor(u.id, { role: 'SA', sites: 'all', staffId: u.staffId }, clock)
}
const alloc = async (a: AllocateInput) => runCommand(await adminRc(), c => allocateBed(c, a))

describe('allocateBed', () => {
  it('creates a claim for [arrival, departure) and returns its id', async () => {
    const { bedIds } = await mkProperty({ beds: 1 })
    const s = await mkStaff()
    const r = await alloc({ bedId: bedIds[0], staffId: s.id, from: day(5), to: day(12), kind: 'reservation' })
    expect(r.ok).toBe(true)
    expect((await liveClaims(bedIds[0])).map(c => c.period)).toEqual([`[${day(5)},${day(12)})`])
  })

  it('same-day turnover: an arrival on the departure day of the previous claim is allowed (D-103)', async () => {
    const { bedIds } = await mkProperty({ beds: 1 })
    await reserve(bedIds[0], day(5), day(12))
    expect((await alloc({ bedId: bedIds[0], staffId: (await mkStaff()).id, from: day(12), to: day(20), kind: 'reservation' })).ok).toBe(true)
    const clash = await alloc({ bedId: bedIds[0], staffId: (await mkStaff()).id, from: day(11), to: day(13), kind: 'reservation' })
    expect(clash.ok).toBe(false)
    if (!clash.ok) { expect(clash.code).toBe('conflict'); expect((clash.detail as any).reason).toBe('bed_taken') }
  })

  it('AT-008 shape: two simultaneous allocations of the same bed and dates, exactly one wins, the loser is told what to do next', async () => {
    const { bedIds, siteId } = await mkProperty({ beds: 3 })
    const [a, b] = [await mkStaff(), await mkStaff()]
    const results = await Promise.all([
      alloc({ bedId: bedIds[0], staffId: a.id, from: day(5), to: day(30), kind: 'reservation' }),
      alloc({ bedId: bedIds[0], staffId: b.id, from: day(5), to: day(30), kind: 'reservation' }),
    ])
    expect(results.filter(r => r.ok)).toHaveLength(1)
    const lost = results.find(r => !r.ok)!
    expect(lost.ok).toBe(false)
    if (!lost.ok) {
      expect(lost.code).toBe('conflict')
      expect(lost.next).toBeTruthy()
      expect(siteId).toBeTruthy()
    }
    expect(await liveClaims(bedIds[0])).toHaveLength(1)
  })

  it('names the next suggested beds when the bed is taken', async () => {
    const { bedIds } = await mkProperty({ beds: 3 })
    await reserve(bedIds[0], day(5), day(30))
    const r = await alloc({ bedId: bedIds[0], staffId: (await mkStaff()).id, from: day(6), to: day(10), kind: 'reservation' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(((r.detail as any).suggestions as any[]).map(s => s.bedId).sort()).toEqual([bedIds[1], bedIds[2]].sort())
  })

  it('refuses blocked, under-maintenance and archived beds, with the reason', async () => {
    const { roomId } = await mkProperty({ beds: 0 })
    for (const state of ['blocked', 'under_maintenance', 'archived']) {
      const bed = await mkBed(roomId, { state })
      const r = await alloc({ bedId: bed, staffId: (await mkStaff()).id, from: day(5), to: day(9), kind: 'reservation' })
      expect(r.ok, state).toBe(false)
      if (!r.ok) expect((r.detail as any).reason).toBe('bed_unavailable')
    }
  })

  it('readiness gates check-in, not the reservation (D-18): a needs-cleaning bed can be reserved, not checked into', async () => {
    const { roomId } = await mkProperty({ beds: 0 })
    const bed = await mkBed(roomId, { state: 'needs_cleaning' })
    const s = await mkStaff()
    expect((await alloc({ bedId: bed, staffId: s.id, from: day(5), to: day(9), kind: 'reservation' })).ok).toBe(true)
    const stay = await alloc({ bedId: bed, staffId: (await mkStaff()).id, from: day(0), to: day(2), kind: 'stay', requireReady: true })
    expect(stay.ok).toBe(false)
    if (!stay.ok) { expect((stay.detail as any).reason).toBe('bed_not_ready'); expect(stay.owner).toBeTruthy(); expect(stay.next).toBeTruthy() }
  })

  it('a bed held by a pending offer cannot be allocated; an offer hold is itself an allocation and converts in place on accept', async () => {
    const { bedIds } = await mkProperty({ beds: 1 })
    const s1 = await mkStaff()
    const hold = await alloc({ bedId: bedIds[0], staffId: s1.id, from: day(5), to: day(60), kind: 'offer_hold' })
    expect(hold.ok).toBe(true)
    const r = await alloc({ bedId: bedIds[0], staffId: (await mkStaff()).id, from: day(5), to: day(60), kind: 'reservation' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect((r.detail as any).reason).toBe('bed_held')
    if (hold.ok) {
      const rc = await adminRc()
      const conv = await runCommand(rc, async c => { await convertClaim(c.tx, hold.data.claimId, 'reservation'); return { ok: true as const, data: undefined } })
      expect(conv.ok).toBe(true)
      expect((await liveClaims(bedIds[0])).map(c => c.kind)).toEqual(['reservation'])
    }
  })

  it('AT-006 shape: a gender-restricted room refuses the wrong gender; a Policy Approver exception allows it and the use is recorded', async () => {
    const siteId = await mkSite()
    const room = await mkRoom(siteId, { gender: 'female' })
    const bed = await mkBed(room)
    const man = await mkStaff({ gender: 'male' })
    const r = await alloc({ bedId: bed, staffId: man.id, from: day(5), to: day(9), kind: 'reservation' })
    expect(r.ok).toBe(false)
    if (!r.ok) { expect((r.detail as any).reason).toBe('not_eligible'); expect((r.detail as any).exceptionable).toBe(true); expect(r.owner).toBe('Policy Approver') }
    expect(await liveClaims(bed)).toHaveLength(0)
    const pa = await makeUser({ roles: [{ role: 'AA', siteId }] })
    const ex = await mkException({ staffId: man.id, kind: 'gender', grantedBy: pa.id })
    const ok = await alloc({ bedId: bed, staffId: man.id, from: day(5), to: day(9), kind: 'reservation' })
    expect(ok.ok).toBe(true)
    if (ok.ok) expect(ok.data.exceptionIds).toEqual([ex])
  })

  it('AT-007 shape: a site grade rule refuses a lower grade; left employees are never exceptionable', async () => {
    const siteId = await mkSite()
    await setConfigValue('eligibility.min_grade', 7, siteId)
    const room = await mkRoom(siteId)
    const [b1, b2] = [await mkBed(room), await mkBed(room)]
    const junior = await mkStaff({ grade: 3 })
    const r = await alloc({ bedId: b1, staffId: junior.id, from: day(5), to: day(9), kind: 'reservation' })
    expect(r.ok).toBe(false)
    if (!r.ok) { expect(r.reason).toMatch(/grade 7\+/); expect((r.detail as any).exceptionable).toBe(true) }
    const left = await mkStaff({ status: 'left', grade: 9 })
    const l = await alloc({ bedId: b2, staffId: left.id, from: day(5), to: day(9), kind: 'reservation' })
    expect(l.ok).toBe(false)
    if (!l.ok) expect((l.detail as any).exceptionable).toBe(false)
  })

  it('one open reservation per person', async () => {
    const { bedIds } = await mkProperty({ beds: 2 })
    const s = await mkStaff()
    expect((await alloc({ bedId: bedIds[0], staffId: s.id, from: day(5), to: day(9), kind: 'reservation' })).ok).toBe(true)
    const rc = await adminRc()
    // the reservation row is created by the package that owns requests; simulate it
    const claim = (await liveClaims(bedIds[0]))[0].id
    await admin().query(`INSERT INTO reservation (staff_id, bed_id, claim_id, eta, source, stay_type) VALUES ($1, $2, $3, now(), 'request', 'contract')`, [s.id, bedIds[0], claim])
    const second = await runCommand(rc, c => allocateBed(c, { bedId: bedIds[1], staffId: s.id, from: day(20), to: day(25), kind: 'reservation' }))
    expect(second.ok).toBe(false)
    if (!second.ok) expect((second.detail as any).reason).toBe('has_reservation')
  })

  it('released claims stop blocking and stay as history', async () => {
    const { bedIds } = await mkProperty({ beds: 1 })
    const { claimId } = await reserve(bedIds[0], day(5), day(30))
    const rc = await adminRc()
    await runCommand(rc, async c => { await releaseClaim(c.tx, claimId, 'test', c.now); return { ok: true as const, data: undefined } })
    expect((await alloc({ bedId: bedIds[0], staffId: (await mkStaff()).id, from: day(6), to: day(10), kind: 'reservation' })).ok).toBe(true)
    const all = (await admin().query(`SELECT released_at FROM bed_claim WHERE id = $1`, [claimId])).rows[0]
    expect(all.released_at).not.toBeNull()
  })

  it('a refused allocation leaves nothing behind (rolled back with the caller)', async () => {
    const { bedIds } = await mkProperty({ beds: 1 })
    await occupy(bedIds[0])
    const before = (await liveClaims(bedIds[0])).length
    await alloc({ bedId: bedIds[0], staffId: (await mkStaff()).id, from: day(5), to: day(9), kind: 'reservation' })
    expect((await liveClaims(bedIds[0])).length).toBe(before)
  })
})

describe('suggestBeds', () => {
  it('ready beds first, then beds that still need cleaning; skips taken and blocked beds', async () => {
    const siteId = await mkSite()
    const room = await mkRoom(siteId)
    const ready = await mkBed(room, { code: 'Z-READY' })
    const dirty = await mkBed(room, { code: 'A-DIRTY', state: 'needs_cleaning' })
    const blocked = await mkBed(room, { state: 'blocked' })
    const taken = await mkBed(room)
    await reserve(taken, day(5), day(30))
    const s = await mkStaff()
    const out = await suggestBeds(getDb(), { staffId: s.id, siteId, from: day(6), to: day(10), limit: 10, now: clock.now() })
    expect(out.map(x => x.bedId)).toEqual([ready, dirty])
    expect(out.map(x => x.bedId)).not.toContain(blocked)
    await setState(dirty, 'inspection_required')
  })
})
