import { afterAll, describe, expect, it } from 'vitest'
import { admin, closeAll } from '../harness'
import {
  as, auditRows, bedState, claimRow, day, liveClaims, mkBed, mkReservation, mkRoom, mkSite, mkStay, notificationsFor, person, residents, setBedState, stayRow, transferRow, world,
} from './helpers'
import { approveTransfer, recordSwapConsent, rejectTransfer } from '@/server/commands/stays/decideTransfer'
import { executeTransfer } from '@/server/commands/stays/executeTransfer'
import { requestSwap, requestTransfer } from '@/server/commands/stays/requestTransfer'
import { cancelRequest } from '@/server/commands/stays/cancel'

afterAll(closeAll)

const req = (stayId: string, destinationBedId: string | null = null, reason = 'Noisy room') => ({ stayId, destinationBedId, reason, neededBy: null, linkedExtensionId: null })

/** A stay with one resident in bed 0 of a fresh site, and a second Accommodation Admin to be the independent approver. */
async function scene(opts: { beds?: number } = {}) {
  const w = await world({ beds: opts.beds ?? 5 })
  const aa2 = await person('AA', { siteIds: [w.siteId] })
  const [res] = await residents(1)
  const s = await mkStay({ bedId: w.bedIds[0], staffId: res.staffId, from: day(-5), to: day(30) })
  return { ...w, aa2, res, ...s }
}

async function approved(sc: Awaited<ReturnType<typeof scene>>, dest: string | null) {
  const r = await requestTransfer(sc.res.rc, req(sc.stayId, dest))
  if (!r.ok) throw new Error('request failed: ' + r.reason)
  const a = await approveTransfer(sc.aa.rc, { id: r.data.id, destinationBedId: null, note: null })
  if (!a.ok) throw new Error('approve failed: ' + a.reason)
  return r.data.id
}

describe('transfer: request, approve, execute (D-61)', () => {
  it('moves the resident: destination allocated first, source released, stay moved, destination Occupied, source Needs cleaning, audit with the key placeholder', async () => {
    const sc = await scene()
    const id = await approved(sc, sc.bedIds[1])
    const out = await executeTransfer(sc.rec.rc, { id })
    expect(out.ok).toBe(true)
    const s = await stayRow(sc.stayId)
    expect(s.bed_id).toBe(sc.bedIds[1])
    expect(s.status).toBe('active')
    expect(s.claim_id).not.toBe(sc.claimId)
    expect(await bedState(sc.bedIds[1])).toBe('occupied')
    expect(await bedState(sc.bedIds[0])).toBe('needs_cleaning')
    const old = await claimRow(sc.claimId)
    expect(old.released_at).not.toBeNull()
    expect(old.release_reason).toBe('transferred')
    const live = await liveClaims(sc.bedIds[1])
    expect(live).toHaveLength(1)
    expect(live[0]).toMatchObject({ id: s.claim_id, kind: 'stay', period: `[${day(0)},${day(30)})` })
    expect(await liveClaims(sc.bedIds[0])).toHaveLength(0)
    expect((await transferRow(id)).status).toBe('executed')
    const a = await auditRows(id)
    expect(a.map(x => x.action)).toEqual(['stays.transfer.requested', 'stays.transfer.approved', 'stays.transfer.executed'])
    expect(a[2].after.keysReturned).toMatch(/Stage 3/)
    expect((await auditRows(sc.stayId)).map(x => x.action)).toContain('stays.stay.moved')
    expect((await notificationsFor(sc.stayId)).map(n => n.kind)).toContain('transfer.executed')
  })

  it('"any suitable bed": the Accommodation Admin must pick one when approving', async () => {
    const sc = await scene()
    const r = await requestTransfer(sc.res.rc, req(sc.stayId, null))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const none = await approveTransfer(sc.aa.rc, { id: r.data.id, destinationBedId: null, note: null })
    expect(!none.ok && none.code).toBe('invalid')
    const ok = await approveTransfer(sc.aa.rc, { id: r.data.id, destinationBedId: sc.bedIds[2], note: null })
    expect(ok.ok).toBe(true)
    expect((await transferRow(r.data.id)).to_bed_id).toBe(sc.bedIds[2])
  })

  it('a cross-site destination is refused at request time (a move to another site is a new request)', async () => {
    const sc = await scene()
    const other = await world({ beds: 1 })
    const r = await requestTransfer(sc.res.rc, req(sc.stayId, other.bedIds[0]))
    expect(!r.ok && r.detail).toMatchObject({ reason: 'cross_site' })
  })

  it('Reception executes approved ones only', async () => {
    const sc = await scene()
    const r = await requestTransfer(sc.res.rc, req(sc.stayId, sc.bedIds[1]))
    if (!r.ok) throw new Error('setup')
    const early = await executeTransfer(sc.rec.rc, { id: r.data.id })
    expect(early.ok).toBe(false)
    if (!early.ok) { expect(early.reason).toMatch(/waiting for approval/); expect(early.owner).toBe('Accommodation Admin'); expect(early.next).toBeTruthy() }
    expect((await stayRow(sc.stayId)).bed_id).toBe(sc.bedIds[0])
    expect((await transferRow(r.data.id)).status).toBe('requested')
  })

  it('a rejected transfer moves nobody; the reason is mandatory', async () => {
    const sc = await scene()
    const r = await requestTransfer(sc.res.rc, req(sc.stayId, sc.bedIds[1]))
    if (!r.ok) throw new Error('setup')
    const rej = await rejectTransfer(sc.aa.rc, { id: r.data.id, reason: 'No spare bed for a month' })
    expect(rej.ok).toBe(true)
    expect((await transferRow(r.data.id)).status).toBe('rejected')
    expect((await stayRow(sc.stayId)).bed_id).toBe(sc.bedIds[0])
    const exec = await executeTransfer(sc.rec.rc, { id: r.data.id })
    expect(exec.ok).toBe(false)
  })

  it('same-day turnover: a reservation on the destination that ends today, or starts after the stay ends, does not block the move (D-103)', async () => {
    const sc = await scene()
    await mkReservation({ bedId: sc.bedIds[1], staffId: (await residents(1))[0].staffId, from: day(-10), to: day(0) })
    await mkReservation({ bedId: sc.bedIds[1], staffId: (await residents(1))[0].staffId, from: day(30), to: day(40) })
    const id = await approved(sc, sc.bedIds[1])
    expect((await executeTransfer(sc.rec.rc, { id })).ok).toBe(true)
    expect((await liveClaims(sc.bedIds[1])).map(c => c.kind)).toEqual(['reservation', 'stay', 'reservation'])
  })
})

describe('AT-022: a transfer whose destination became unavailable fails safely', () => {
  /** Everything about the resident that must be exactly as before. */
  async function snapshot(sc: Awaited<ReturnType<typeof scene>>, dest: string) {
    return {
      stay: await stayRow(sc.stayId),
      claim: await claimRow(sc.claimId),
      source: await bedState(sc.bedIds[0]),
      dest: await bedState(dest),
      sourceClaims: (await liveClaims(sc.bedIds[0])).map(c => c.id),
      destClaims: (await liveClaims(dest)).map(c => c.id),
      stayAudit: (await auditRows(sc.stayId)).length,
    }
  }

  const cases: [string, (sc: Awaited<ReturnType<typeof scene>>, dest: string) => Promise<void>, string][] = [
    ['the destination was blocked after approval', async (_sc, dest) => setBedState(dest, 'blocked'), 'bed_unavailable'],
    ['the destination was reserved by someone else after approval', async (_sc, dest) => { await mkReservation({ bedId: dest, staffId: (await residents(1))[0].staffId, from: day(2), to: day(9) }) }, 'bed_taken'],
    ['the destination needs cleaning (not ready)', async (_sc, dest) => { await setBedState(dest, 'needs_cleaning') }, 'bed_not_ready'],
    ['the destination was held by a bed offer', async (_sc, dest) => {
      await admin().query(`INSERT INTO bed_claim (bed_id, kind, period) VALUES ($1, 'offer_hold', $2::daterange)`, [dest, `[${day(1)},${day(60)})`])
    }, 'bed_held'],
  ]
  for (const [name, breakIt, reason] of cases) {
    it(`${name}: nothing moves, the request is marked failed with the reason, and the Accommodation Admin is told what to do`, async () => {
      const sc = await scene()
      const dest = sc.bedIds[1]
      const id = await approved(sc, dest)
      await breakIt(sc, dest)
      const before = await snapshot(sc, dest)

      const out = await executeTransfer(sc.rec.rc, { id })
      expect(out.ok).toBe(false)
      if (out.ok) return
      expect(out.code).toBe('conflict')
      expect(out.detail).toMatchObject({ reason, executionFailed: true })
      expect(out.owner).toBeTruthy()
      expect(out.next).toBeTruthy()

      // the resident is exactly where they were: stay, claim, both beds, keys/audit untouched
      expect(await snapshot(sc, dest)).toEqual(before)
      expect((await claimRow(sc.claimId)).released_at).toBeNull()

      // the surviving record
      const t = await transferRow(id)
      expect(t.status).toBe('failed')
      expect(t.failure_reason).toBe(out.reason)
      expect(t.failure_count).toBe(1)
      expect(t.executed_at).toBeNull()
      expect(t.new_claim_id).toBeNull()
      const actions = (await auditRows(id)).map(x => x.action)
      expect(actions).toContain('stays.transfer.failed')
      expect(actions).not.toContain('stays.transfer.executed')
      const told = (await notificationsFor(id)).find(n => n.kind === 'transfer.failed' && n.to_role === 'AA')
      expect(told?.critical).toBe(true)
      expect(told?.text).toMatch(/nobody was moved/)
    })
  }

  it('the Accommodation Admin then chooses another bed and approves again; a failed request cannot be executed as is', async () => {
    const sc = await scene()
    const id = await approved(sc, sc.bedIds[1])
    await setBedState(sc.bedIds[1], 'blocked')
    expect((await executeTransfer(sc.rec.rc, { id })).ok).toBe(false)
    const again = await executeTransfer(sc.rec.rc, { id })
    expect(!again.ok && again.reason).toMatch(/failed the last time/)
    const re = await approveTransfer(sc.aa.rc, { id, destinationBedId: sc.bedIds[2], note: null })
    expect(re.ok).toBe(true)
    const ok = await executeTransfer(sc.rec.rc, { id })
    expect(ok.ok).toBe(true)
    expect((await stayRow(sc.stayId)).bed_id).toBe(sc.bedIds[2])
    expect(await bedState(sc.bedIds[1])).toBe('blocked')
  })

  it('a destination that became ineligible (room turned female-only) fails safely', async () => {
    const siteId = await mkSite()
    const roomA = await mkRoom(siteId), roomB = await mkRoom(siteId)
    const bedA = await mkBed(roomA), bedB = await mkBed(roomB)
    const aa = await person('AA', { siteIds: [siteId] }), rec = await person('Rec', { siteIds: [siteId] })
    const [res] = await residents(1)
    await admin().query(`UPDATE staff_profile SET gender = 'male' WHERE id = $1`, [res.staffId])
    const s = await mkStay({ bedId: bedA, staffId: res.staffId, from: day(-1), to: day(20) })
    const r = await requestTransfer(res.rc, req(s.stayId, bedB))
    if (!r.ok) throw new Error('setup')
    expect((await approveTransfer(aa.rc, { id: r.data.id, destinationBedId: null, note: null })).ok).toBe(true)
    await admin().query(`UPDATE room SET gender_policy = 'female' WHERE id = $1`, [roomB])
    const out = await executeTransfer(rec.rc, { id: r.data.id })
    expect(!out.ok && out.detail).toMatchObject({ reason: 'not_eligible', executionFailed: true })
    expect((await stayRow(s.stayId)).bed_id).toBe(bedA)
    expect(await bedState(bedA)).toBe('occupied')
    expect(await bedState(bedB)).toBe('available')
    expect((await transferRow(r.data.id)).status).toBe('failed')
  })

  it('a stay that ended or moved since approval cannot be moved (stale), and nothing changes', async () => {
    const sc = await scene()
    const id = await approved(sc, sc.bedIds[1])
    await admin().query(`UPDATE stay SET status = 'checked_out', checked_out_at = now() WHERE id = $1`, [sc.stayId])
    const out = await executeTransfer(sc.rec.rc, { id })
    expect(!out.ok && out.detail).toMatchObject({ reason: 'stale' })
    expect(await bedState(sc.bedIds[1])).toBe('available')
    expect((await transferRow(id)).status).toBe('failed')
  })
})

describe('transfer concurrency', () => {
  it('two transfers into the same bed at once: exactly one executes, the other fails safely with a next action', async () => {
    const w = await world({ beds: 4 })
    const aa2 = await person('AA', { siteIds: [w.siteId] })
    const [r1, r2] = await residents(2)
    const s1 = await mkStay({ bedId: w.bedIds[0], staffId: r1.staffId, from: day(-5), to: day(30) })
    const s2 = await mkStay({ bedId: w.bedIds[1], staffId: r2.staffId, from: day(-5), to: day(30) })
    const dest = w.bedIds[2]
    const ids: string[] = []
    for (const [res, s] of [[r1, s1], [r2, s2]] as const) {
      const r = await requestTransfer(res.rc, req(s.stayId, dest))
      if (!r.ok) throw new Error('setup')
      expect((await approveTransfer(aa2.rc, { id: r.data.id, destinationBedId: null, note: null })).ok).toBe(true)
      ids.push(r.data.id)
    }
    const rec2 = await person('Rec', { siteIds: [w.siteId] })
    const results = await Promise.all([executeTransfer(w.rec.rc, { id: ids[0] }), executeTransfer(rec2.rc, { id: ids[1] })])
    expect(results.filter(r => r.ok)).toHaveLength(1)
    const lost = results.find(r => !r.ok)!
    expect(!lost.ok && lost.detail).toMatchObject({ reason: 'bed_taken', executionFailed: true })
    expect(!lost.ok && lost.next).toBeTruthy()
    // exactly one live claim on the destination, exactly one resident moved, the other still in place
    expect(await liveClaims(dest)).toHaveLength(1)
    const winnerIdx = results[0].ok ? 0 : 1
    const loserStay = winnerIdx === 0 ? s2 : s1
    const loserBed = winnerIdx === 0 ? w.bedIds[1] : w.bedIds[0]
    expect((await stayRow(loserStay.stayId)).bed_id).toBe(loserBed)
    expect(await bedState(loserBed)).toBe('occupied')
    expect((await transferRow(ids[winnerIdx ? 0 : 1])).status).toBe('failed')
    expect((await transferRow(ids[winnerIdx])).status).toBe('executed')
  })

  it('executing the same transfer twice at once moves the resident once', async () => {
    const sc = await scene()
    const id = await approved(sc, sc.bedIds[1])
    const rec2 = await person('Rec', { siteIds: [sc.siteId] })
    const results = await Promise.all([executeTransfer(sc.rec.rc, { id }), executeTransfer(rec2.rc, { id })])
    expect(results.filter(r => r.ok)).toHaveLength(1)
    expect((await stayRow(sc.stayId)).bed_id).toBe(sc.bedIds[1])
    expect((await transferRow(id)).status).toBe('executed')
    expect((await auditRows(id)).filter(a => a.action === 'stays.transfer.executed')).toHaveLength(1)
  })
})

describe('transfer: separation of duties (D-26) and scope', () => {
  it('whoever raised it cannot approve it; the person it is about cannot; an independent Accommodation Admin can', async () => {
    const sc = await scene()
    const raised = await requestTransfer(sc.aa.rc, req(sc.stayId, sc.bedIds[1]))
    if (!raised.ok) throw new Error('setup')
    const self = await approveTransfer(sc.aa.rc, { id: raised.data.id, destinationBedId: null, note: null })
    expect(!self.ok && self.code).toBe('separation_of_duties')
    // the resident is also an Accommodation Admin in another session: still not their own
    const dual = as({ ...sc.res }, 'AA', { siteIds: [sc.siteId] })
    const own = await approveTransfer(dual.rc, { id: raised.data.id, destinationBedId: null, note: null })
    expect(!own.ok && own.code).toBe('separation_of_duties')
    expect((await transferRow(raised.data.id)).status).toBe('requested')
    expect((await approveTransfer(sc.aa2.rc, { id: raised.data.id, destinationBedId: null, note: null })).ok).toBe(true)
  })

  it('Reception cannot carry out their own transfer', async () => {
    const w = await world()
    const aa2 = await person('AA', { siteIds: [w.siteId] })
    const recRes = await person('Rec', { siteIds: [w.siteId] })
    const s = await mkStay({ bedId: w.bedIds[0], staffId: recRes.staffId, from: day(-2), to: day(30) })
    const r = await requestTransfer(w.aa.rc, req(s.stayId, w.bedIds[1]))
    if (!r.ok) throw new Error('setup')
    await approveTransfer(aa2.rc, { id: r.data.id, destinationBedId: null, note: null })
    const self = await executeTransfer(recRes.rc, { id: r.data.id })
    expect(!self.ok && self.code).toBe('separation_of_duties')
    expect((await executeTransfer(w.rec.rc, { id: r.data.id })).ok).toBe(true)
  })

  it('scope: another site\'s Accommodation Admin and Reception get "not found"; a resident cannot request for someone else\'s stay', async () => {
    const sc = await scene()
    const elsewhere = await world({ beds: 1 })
    const r = await requestTransfer(sc.res.rc, req(sc.stayId, sc.bedIds[1]))
    if (!r.ok) throw new Error('setup')
    const aaOther = await approveTransfer(elsewhere.aa.rc, { id: r.data.id, destinationBedId: null, note: null })
    expect(!aaOther.ok && aaOther.code).toBe('not_found')
    await approveTransfer(sc.aa.rc, { id: r.data.id, destinationBedId: null, note: null })
    const recOther = await executeTransfer(elsewhere.rec.rc, { id: r.data.id })
    expect(!recOther.ok && recOther.code).toBe('not_found')
    const [stranger] = await residents(1)
    const foreign = await requestTransfer(stranger.rc, req(sc.stayId, sc.bedIds[2]))
    expect(!foreign.ok && foreign.code).toBe('not_found')
    // Reception cannot approve at all
    const rec = await approveTransfer(sc.rec.rc, { id: r.data.id, destinationBedId: null, note: null })
    expect(rec.ok).toBe(false)
  })

  it('the resident can cancel their own request; nothing about the stay changes', async () => {
    const sc = await scene()
    const r = await requestTransfer(sc.res.rc, req(sc.stayId, sc.bedIds[1]))
    if (!r.ok) throw new Error('setup')
    const c = await cancelRequest(sc.res.rc, { kind: 'transfer', id: r.data.id, note: null })
    expect(c.ok).toBe(true)
    expect((await transferRow(r.data.id)).status).toBe('cancelled')
    expect((await stayRow(sc.stayId)).bed_id).toBe(sc.bedIds[0])
  })
})

describe('swap (D-62): one atomic two-way operation', () => {
  async function swapScene() {
    const w = await world({ beds: 4 })
    const aa2 = await person('AA', { siteIds: [w.siteId] })
    const [ra, rb] = await residents(2)
    const a = await mkStay({ bedId: w.bedIds[0], staffId: ra.staffId, from: day(-5), to: day(30) })
    const b = await mkStay({ bedId: w.bedIds[1], staffId: rb.staffId, from: day(-2), to: day(40) })
    const consent = { via: 'in_person' as const, note: null }
    const r = await requestSwap(w.aa.rc, { stayId: a.stayId, otherStayId: b.stayId, reason: 'Friends', neededBy: null, consentFirst: consent, consentSecond: consent })
    if (!r.ok) throw new Error('swap request failed: ' + r.reason)
    return { ...w, aa2, ra, rb, a, b, id: r.data.id }
  }

  it('swaps both residents in one operation: both beds stay Occupied, each resident keeps their own end date, no transfer in between', async () => {
    const sc = await swapScene()
    expect((await approveTransfer(sc.aa2.rc, { id: sc.id, destinationBedId: null, note: null })).ok).toBe(true)
    const out = await executeTransfer(sc.rec.rc, { id: sc.id })
    expect(out.ok).toBe(true)
    const [a, b] = [await stayRow(sc.a.stayId), await stayRow(sc.b.stayId)]
    expect([a.bed_id, b.bed_id]).toEqual([sc.bedIds[1], sc.bedIds[0]])
    expect(await bedState(sc.bedIds[0])).toBe('occupied')
    expect(await bedState(sc.bedIds[1])).toBe('occupied')
    expect(await liveClaims(sc.bedIds[0])).toMatchObject([{ id: b.claim_id, kind: 'stay', period: `[${day(0)},${day(40)})` }])
    expect(await liveClaims(sc.bedIds[1])).toMatchObject([{ id: a.claim_id, kind: 'stay', period: `[${day(0)},${day(30)})` }])
    expect((await claimRow(sc.a.claimId)).release_reason).toBe('swapped')
    expect((await auditRows(sc.id)).map(x => x.action)).toContain('stays.swap.executed')
    expect((await transferRow(sc.id)).kind).toBe('swap')
  })

  it('a swap where one destination is no longer open for the other resident\'s whole stay fails safely: both residents stay put, both original claims are still live', async () => {
    const sc = await swapScene()
    expect((await approveTransfer(sc.aa2.rc, { id: sc.id, destinationBedId: null, note: null })).ok).toBe(true)
    // bed 0 is booked from day 35; resident A leaves on day 30, but resident B stays until day 40, so B cannot move into bed 0
    await mkReservation({ bedId: sc.bedIds[0], staffId: (await residents(1))[0].staffId, from: day(35), to: day(50) })
    const out = await executeTransfer(sc.rec.rc, { id: sc.id })
    expect(out.ok).toBe(false)
    if (!out.ok) { expect(out.detail).toMatchObject({ reason: 'bed_taken', executionFailed: true }); expect(out.next).toBeTruthy() }
    const [a, b] = [await stayRow(sc.a.stayId), await stayRow(sc.b.stayId)]
    expect([a.bed_id, b.bed_id]).toEqual([sc.bedIds[0], sc.bedIds[1]])
    expect([a.claim_id, b.claim_id]).toEqual([sc.a.claimId, sc.b.claimId])
    expect((await claimRow(sc.a.claimId)).released_at).toBeNull()
    expect((await claimRow(sc.b.claimId)).released_at).toBeNull()
    expect((await liveClaims(sc.bedIds[1])).map(c => c.id)).toEqual([sc.b.claimId])
    expect((await liveClaims(sc.bedIds[0])).map(c => c.kind).sort()).toEqual(['reservation', 'stay'])
    expect(await bedState(sc.bedIds[0])).toBe('occupied')
    expect(await bedState(sc.bedIds[1])).toBe('occupied')
    expect((await transferRow(sc.id)).status).toBe('failed')
  })

  it('a swap that fails on eligibility for the second resident rolls back the first resident\'s move too', async () => {
    const siteId = await mkSite()
    const roomA = await mkRoom(siteId), roomB = await mkRoom(siteId)
    const bedA = await mkBed(roomA), bedB = await mkBed(roomB)
    const aa = await person('AA', { siteIds: [siteId] }), aa2 = await person('AA', { siteIds: [siteId] }), rec = await person('Rec', { siteIds: [siteId] })
    const [ra, rb] = await residents(2)
    await admin().query(`UPDATE staff_profile SET gender = 'female' WHERE id = $1`, [ra.staffId])
    await admin().query(`UPDATE staff_profile SET gender = 'male' WHERE id = $1`, [rb.staffId])
    const a = await mkStay({ bedId: bedA, staffId: ra.staffId, from: day(-5), to: day(30) })
    const b = await mkStay({ bedId: bedB, staffId: rb.staffId, from: day(-5), to: day(30) })
    const c = { via: 'phone' as const, note: null }
    const r = await requestSwap(aa.rc, { stayId: a.stayId, otherStayId: b.stayId, reason: 'x', neededBy: null, consentFirst: c, consentSecond: c })
    if (!r.ok) throw new Error('setup')
    await approveTransfer(aa2.rc, { id: r.data.id, destinationBedId: null, note: null })
    // Room A turns female-only: the female resident may move into B (checked first) but the male resident may not move into A (checked second).
    await admin().query(`UPDATE room SET gender_policy = 'female' WHERE id = $1`, [roomA])
    const out = await executeTransfer(rec.rc, { id: r.data.id })
    expect(!out.ok && out.detail).toMatchObject({ reason: 'not_eligible', executionFailed: true })
    expect((await stayRow(a.stayId)).bed_id).toBe(bedA)
    expect((await stayRow(b.stayId)).bed_id).toBe(bedB)
    expect((await claimRow(a.claimId)).released_at).toBeNull()
    expect((await claimRow(b.claimId)).released_at).toBeNull()
  })

  it('a swap needs both residents\' consent before it can be approved; an occupant confirms in the app, the admin records the other', async () => {
    const w = await world({ beds: 2 })
    const aa2 = await person('AA', { siteIds: [w.siteId] })
    const [ra, rb] = await residents(2)
    const a = await mkStay({ bedId: w.bedIds[0], staffId: ra.staffId, from: day(-5), to: day(30) })
    const b = await mkStay({ bedId: w.bedIds[1], staffId: rb.staffId, from: day(-5), to: day(30) })
    const r = await requestSwap(w.aa.rc, { stayId: a.stayId, otherStayId: b.stayId, reason: 'x', neededBy: null, consentFirst: null, consentSecond: null })
    if (!r.ok) throw new Error('setup')
    const id = r.data.id
    const none = await approveTransfer(aa2.rc, { id, destinationBedId: null, note: null })
    expect(!none.ok && none.detail).toMatchObject({ reason: 'consent_missing' })
    expect((await notificationsFor(id)).filter(n => n.kind === 'swap.consent_needed')).toHaveLength(2)

    const mine = await recordSwapConsent(ra.rc, { id, party: null, via: null, note: null })
    expect(mine.ok && mine.data).toMatchObject({ party: 'a', consentComplete: false })
    // a resident cannot consent for the other
    const stranger = (await residents(1))[0]
    expect((await recordSwapConsent(stranger.rc, { id, party: 'b', via: 'phone', note: null })).ok).toBe(false)
    const missingParty = await recordSwapConsent(w.aa.rc, { id, party: null, via: null, note: null })
    expect(!missingParty.ok && missingParty.code).toBe('invalid')
    const theirs = await recordSwapConsent(w.aa.rc, { id, party: 'b', via: 'phone', note: 'Called at 10:00' })
    expect(theirs.ok && theirs.data).toMatchObject({ party: 'b', consentComplete: true })
    expect((await transferRow(id)).consent_b_via).toBe('phone')
    expect((await approveTransfer(aa2.rc, { id, destinationBedId: null, note: null })).ok).toBe(true)
  })

  it('a resident in a swap can decline their part before it is approved; nobody moves', async () => {
    const sc = await swapScene()
    const declined = await rejectTransfer(sc.rb.rc, { id: sc.id, reason: 'I prefer to stay' })
    expect(declined.ok).toBe(true)
    expect((await transferRow(sc.id)).status).toBe('rejected')
    expect((await stayRow(sc.b.stayId)).bed_id).toBe(sc.bedIds[1])
  })

  it('the Accommodation Admin who raised a swap cannot approve it; neither of the residents can', async () => {
    const sc = await swapScene()
    const own = await approveTransfer(sc.aa.rc, { id: sc.id, destinationBedId: null, note: null })
    expect(!own.ok && own.code).toBe('separation_of_duties')
    const dual = as(sc.ra, 'AA', { siteIds: [sc.siteId] })
    const part = await approveTransfer(dual.rc, { id: sc.id, destinationBedId: null, note: null })
    expect(!part.ok && part.code).toBe('separation_of_duties')
  })
})
