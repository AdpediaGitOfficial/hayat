import { afterAll, describe, expect, it } from 'vitest'
import { admin, closeAll } from '../harness'
import { auditRows, bedState, claimRow, day, liveClaims, mkReservation, mkStay, notificationsFor, person, residents, setBedState, stayRow, world } from './helpers'
import { acknowledgeCheckout, processCheckout, requestCheckout } from '@/server/commands/stays/checkout'
import { checkIn } from '@/server/commands/stays/checkIn'
import { cancelRequest } from '@/server/commands/stays/cancel'

afterAll(closeAll)

const ask = (stayId: string, departureDate: string, note: string | null = null) => ({ stayId, departureDate, note })
const proc = (stayId: string) => ({ stayId, note: null })

async function scene() {
  const w = await world({ beds: 3 })
  const [res] = await residents(1)
  const s = await mkStay({ bedId: w.bedIds[0], staffId: res.staffId, from: day(-10), to: day(40) })
  return { ...w, res, ...s }
}

describe('voluntary checkout (D-63)', () => {
  it('request, acknowledge, process: stay checked out, claim released with a reason, bed Needs cleaning (not Available), resident told, audited', async () => {
    const sc = await scene()
    const r = await requestCheckout(sc.res.rc, ask(sc.stayId, day(5), 'Moving to family housing'))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect((await notificationsFor(r.data.id)).find(n => n.kind === 'checkout.requested')?.to_role).toBe('Rec')
    expect((await acknowledgeCheckout(sc.rec.rc, { id: r.data.id })).ok).toBe(true)
    expect((await acknowledgeCheckout(sc.rec.rc, { id: r.data.id })).ok).toBe(true) // idempotent

    const done = await processCheckout(sc.rec.rc, proc(sc.stayId))
    expect(done.ok && done.data).toMatchObject({ stayId: sc.stayId, bedState: 'needs_cleaning', checkoutRequestId: r.data.id })
    const s = await stayRow(sc.stayId)
    expect(s.status).toBe('checked_out')
    expect(s.checked_out_at).not.toBeNull()
    const c = await claimRow(sc.claimId)
    expect(c.released_at).not.toBeNull()
    expect(c.release_reason).toBe('checked_out')
    expect(await liveClaims(sc.bedIds[0])).toHaveLength(0)
    expect(await bedState(sc.bedIds[0])).toBe('needs_cleaning') // checkout != clearance != bed ready (D-64)
    expect((await admin().query(`SELECT status FROM checkout_request WHERE id = $1`, [r.data.id])).rows[0].status).toBe('completed')
    const a = await auditRows(sc.stayId)
    expect(a.at(-1)?.action).toBe('stays.stay.checked_out')
    expect(a.at(-1)?.after).toMatchObject({ status: 'checked_out', bed: 'needs_cleaning', claim: 'released', clearance: expect.stringMatching(/Stage 3/) })
    expect((await notificationsFor(sc.stayId)).map(n => n.kind)).toContain('stay.checked_out')
  })

  it('the resident keeps their login and history (D-39): checkout touches neither the account nor the staff record', async () => {
    const sc = await scene()
    const before = (await admin().query(`SELECT u.status, u.revoked_at, s.employment_status FROM user_account u JOIN staff_profile s ON s.id = u.staff_id WHERE s.id = $1`, [sc.res.staffId])).rows[0]
    await processCheckout(sc.rec.rc, proc(sc.stayId))
    const after = (await admin().query(`SELECT u.status, u.revoked_at, s.employment_status FROM user_account u JOIN staff_profile s ON s.id = u.staff_id WHERE s.id = $1`, [sc.res.staffId])).rows[0]
    expect(after).toEqual(before)
    expect(after.status).toBe('active')
    expect((await stayRow(sc.stayId)).status).toBe('checked_out') // history stays; no deletion
  })

  it('works without a request (a walk-up departure, or an overdue resident who has finally left) and is the way an overdue stay ends', async () => {
    const w = await world({ beds: 1 })
    const [res] = await residents(1)
    const s = await mkStay({ bedId: w.bedIds[0], staffId: res.staffId, from: day(-30), to: day(-3) }) // overdue
    const out = await processCheckout(w.rec.rc, proc(s.stayId))
    expect(out.ok && out.data.checkoutRequestId).toBeNull()
    expect(await bedState(w.bedIds[0])).toBe('needs_cleaning')
  })

  it('a second checkout is refused, and two at once check out once', async () => {
    const sc = await scene()
    const rec2 = await person('Rec', { siteIds: [sc.siteId] })
    const results = await Promise.all([processCheckout(sc.rec.rc, proc(sc.stayId)), processCheckout(rec2.rc, proc(sc.stayId))])
    expect(results.filter(r => r.ok)).toHaveLength(1)
    const lost = results.find(r => !r.ok)
    expect(!lost?.ok && lost?.detail).toMatchObject({ reason: 'already_checked_out' })
    expect((await auditRows(sc.stayId)).filter(a => a.action === 'stays.stay.checked_out')).toHaveLength(1)
  })

  it('validates the request: not in the past, not after the planned end; one open request per stay', async () => {
    const sc = await scene()
    const past = await requestCheckout(sc.res.rc, ask(sc.stayId, day(-1)))
    expect(!past.ok && past.fields).toHaveProperty('departureDate')
    const late = await requestCheckout(sc.res.rc, ask(sc.stayId, day(41)))
    expect(!late.ok && late.fields).toHaveProperty('departureDate')
    expect((await requestCheckout(sc.res.rc, ask(sc.stayId, day(40)))).ok).toBe(true)
    const dup = await requestCheckout(sc.res.rc, ask(sc.stayId, day(10)))
    expect(!dup.ok && dup.detail).toMatchObject({ reason: 'open_checkout' })
  })

  it('SoD and scope: Reception cannot check out themselves; another site gets "not found"; a resident cannot process or request for another', async () => {
    const w = await world({ beds: 2 })
    const recRes = await person('Rec', { siteIds: [w.siteId] })
    const s = await mkStay({ bedId: w.bedIds[0], staffId: recRes.staffId, from: day(-2), to: day(30) })
    const self = await processCheckout(recRes.rc, proc(s.stayId))
    expect(!self.ok && self.code).toBe('separation_of_duties')
    expect((await stayRow(s.stayId)).status).toBe('active')

    const sc = await scene()
    const elsewhere = await world({ beds: 1 })
    const out = await processCheckout(elsewhere.rec.rc, proc(sc.stayId))
    expect(!out.ok && out.code).toBe('not_found')
    const byRes = await processCheckout(sc.res.rc, proc(sc.stayId))
    expect(!byRes.ok && byRes.code).toBe('forbidden')
    const [stranger] = await residents(1)
    const foreign = await requestCheckout(stranger.rc, ask(sc.stayId, day(5)))
    expect(!foreign.ok && foreign.code).toBe('not_found')
    // Reception cannot request on a resident's behalf (the resident asks; Reception processes)
    const byRec = await requestCheckout(sc.rec.rc, ask(sc.stayId, day(5)))
    expect(byRec.ok).toBe(false)
  })

  it('the resident can withdraw the request; nothing about the stay changes', async () => {
    const sc = await scene()
    const r = await requestCheckout(sc.res.rc, ask(sc.stayId, day(5)))
    if (!r.ok) throw new Error('setup')
    expect((await cancelRequest(sc.res.rc, { kind: 'checkout', id: r.data.id, note: null })).ok).toBe(true)
    expect((await stayRow(sc.stayId)).status).toBe('active')
    expect((await acknowledgeCheckout(sc.rec.rc, { id: r.data.id })).ok).toBe(false)
  })
})

describe('same-day turnover (STAGE-2 proof 3) and readiness after checkout', () => {
  it('a departure on day D frees the bed for an arrival on day D at the claim level; the arrival can check in once the bed is cleaned and inspected, not before', async () => {
    const w = await world({ beds: 1 })
    const [leaving, arriving] = await residents(2)
    const stay = await mkStay({ bedId: w.bedIds[0], staffId: leaving.staffId, from: day(-10), to: day(0) })
    // the next arrival is reserved from the departure day: allowed, the claims do not overlap (D-103)
    const next = await mkReservation({ bedId: w.bedIds[0], staffId: arriving.staffId, from: day(0), to: day(20) })
    expect((await liveClaims(w.bedIds[0])).map(c => c.kind)).toEqual(['stay', 'reservation'])

    // before the previous resident has gone, check-in is refused (the bed is still Occupied)
    const blocked = await checkIn(w.rec.rc, { reservationId: next.reservationId })
    expect(!blocked.ok && blocked.detail).toMatchObject({ reason: 'bed_occupied' })

    // checkout leaves the bed in Needs cleaning: still not ready (checkout != bed ready, D-64)
    expect((await processCheckout(w.rec.rc, proc(stay.stayId))).ok).toBe(true)
    const stillNot = await checkIn(w.rec.rc, { reservationId: next.reservationId })
    expect(!stillNot.ok && stillNot.detail).toMatchObject({ reason: 'bed_not_ready', state: 'needs_cleaning' })

    // Stage 3 will do the cleaning and the final inspection; here the legal path is applied directly
    await setBedState(w.bedIds[0], 'available')
    const ok = await checkIn(w.rec.rc, { reservationId: next.reservationId })
    expect(ok.ok).toBe(true)
    expect(await bedState(w.bedIds[0])).toBe('occupied')
    expect((await liveClaims(w.bedIds[0])).map(c => c.kind)).toEqual(['stay'])
  })
})
