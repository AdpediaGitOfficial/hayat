import { afterAll, describe, expect, it } from 'vitest'
import { admin, call, closeAll } from '../harness'
import { auditActions, claimsOf, day, mkProperty, mkRequest, mkStaff, must, notifCount, reservationsOf, scenario, who } from './helpers'
import { approveRequest } from '@/server/commands/requests/approve'
import { cancelReservation, extendNoShow } from '@/server/commands/allocation-admin/reservations'
import { getReservation, listReservations } from '@/server/queries/requests/reservations'
import { getDb } from '@/server/db/client'
import { POST as cancelRoute } from '../../../app/api/v1/requests/reservations/[id]/cancel/route'
import { POST as extendRoute } from '../../../app/api/v1/requests/reservations/[id]/extend-no-show/route'

afterAll(closeAll)

async function reserved() {
  const s = await scenario({ beds: 2 })
  const out = must(await approveRequest(s.aa.rc, { requestId: s.requestId, bedId: s.bedIds[0] }))
  return { ...s, reservationId: out.reservationId }
}
const row = async (id: string) => (await admin().query(`SELECT * FROM reservation WHERE id = $1`, [id])).rows[0] as Record<string, any>

describe('cancel a reservation (AA, reason required)', () => {
  it('releases the claim in the same step: the bed is free again for those dates, the resident is told once, audit has the reason', async () => {
    const s = await reserved()
    expect(await claimsOf(s.bedIds[0])).toHaveLength(1)
    const out = must(await cancelReservation(s.aa.rc, { reservationId: s.reservationId, reason: 'Resident moved to another city' }))
    expect(out.status).toBe('cancelled')
    expect(await row(s.reservationId)).toMatchObject({ status: 'cancelled', cancel_reason: 'Resident moved to another city' })
    expect(await claimsOf(s.bedIds[0])).toHaveLength(0)
    const released = (await admin().query(`SELECT release_reason FROM bed_claim WHERE bed_id = $1`, [s.bedIds[0]])).rows[0]
    expect(released.release_reason).toMatch(/Reservation cancelled/)
    expect(await auditActions(s.reservationId)).toEqual(['requests.reservation.created', 'requests.reservation.cancelled'])
    expect(await notifCount(`reservation:${s.reservationId}:cancelled`)).toBe(1)
    // the same bed and dates can be given to someone else straight away
    const next = await mkRequest({ staffId: (await mkStaff()).id, siteId: s.siteId, arrival: day(10), end: day(40) })
    must(await approveRequest(s.aa.rc, { requestId: next, bedId: s.bedIds[0] }))
    // a retried cancel answers the same and writes nothing more
    must(await cancelReservation(s.aa.rc, { reservationId: s.reservationId, reason: 'Resident moved to another city' }))
    expect(await notifCount(`reservation:${s.reservationId}:cancelled`)).toBe(1)
    expect(await claimsOf(s.bedIds[0])).toHaveLength(1)
  })

  it('refuses a reservation that is not reserved any more, with who owns the next step', async () => {
    const s = await reserved()
    await admin().query(`UPDATE reservation SET status = 'checked_in' WHERE id = $1`, [s.reservationId])
    const r = await cancelReservation(s.aa.rc, { reservationId: s.reservationId, reason: 'late' })
    expect(r.ok).toBe(false)
    if (!r.ok) { expect(r.code).toBe('conflict'); expect(r.owner).toBe('Reception'); expect(r.next).toBeTruthy() }
    expect(await claimsOf(s.bedIds[0])).toHaveLength(1)
  })

  it('Reception 403, another site 404, own reservation separation of duties, reason required (422), all over the API where it applies', async () => {
    const s = await reserved()
    const rec = await who('Rec', { siteIds: [s.siteId] })
    const outsider = await who('AA', { siteIds: [(await mkProperty()).siteId] })
    expect((await call(cancelRoute, { cookie: await rec.cookie(), params: { id: s.reservationId }, body: { reason: 'no way' } })).status).toBe(403)
    expect((await call(cancelRoute, { cookie: await outsider.cookie(), params: { id: s.reservationId }, body: { reason: 'no way' } })).status).toBe(404)
    expect((await call(cancelRoute, { cookie: await s.aa.cookie(), params: { id: s.reservationId }, body: {} })).status).toBe(422)
    expect(await claimsOf(s.bedIds[0])).toHaveLength(1)

    // an AA who is the resident of a reservation cannot cancel it in the AA seat
    const mine = await mkProperty({ beds: 1 })
    const aa = await who('AA', { siteIds: [mine.siteId] })
    const req = await mkRequest({ staffId: aa.staffId, siteId: mine.siteId, arrival: day(4), end: day(9) })
    const other = await who('AA', { siteIds: [mine.siteId] })
    const ok = must(await approveRequest(other.rc, { requestId: req, bedId: mine.bedIds[0] }))
    const self = await cancelReservation(aa.rc, { reservationId: ok.reservationId, reason: 'cancel my own' })
    expect(self.ok).toBe(false)
    if (!self.ok) expect(self.code).toBe('separation_of_duties')
  })
})

describe('no-show extension (D-58): once, with a reason, by the AA', () => {
  it('sets no_show_extended, moves the deadline from eta+24h to eta+48h, audits the reason, tells the resident, and only once', async () => {
    const s = await reserved()
    const before = (await getReservation(getDb(), s.aa.rc.actor, s.reservationId))!
    const eta = Date.parse(before.eta)
    expect(Date.parse(before.noShowDeadline)).toBe(eta + 24 * 3600_000)
    expect(before.can.extend).toBe(true)

    const out = must(await extendNoShow(s.aa.rc, { reservationId: s.reservationId, reason: 'Flight delayed to the next day' }))
    expect(Date.parse(out.noShowDeadline)).toBe(eta + 48 * 3600_000)
    expect((await row(s.reservationId)).no_show_extended).toBe(true)
    const audit = (await admin().query(`SELECT reason FROM audit_event WHERE entity_id = $1 AND action = 'requests.reservation.no_show_extended'`, [s.reservationId])).rows
    expect(audit).toEqual([{ reason: 'Flight delayed to the next day' }])
    expect(await notifCount(`reservation:${s.reservationId}:no_show_extended`)).toBe(1)

    const second = await extendNoShow(s.aa.rc, { reservationId: s.reservationId, reason: 'Still delayed' })
    expect(second.ok).toBe(false)
    if (!second.ok) { expect(second.code).toBe('conflict'); expect((second.detail as any).reason).toBe('extension_limit'); expect(second.next).toBeTruthy() }
    const after = (await getReservation(getDb(), s.aa.rc.actor, s.reservationId))!
    expect(after.can.extend).toBe(false)
    expect(Date.parse(after.noShowDeadline)).toBe(eta + 48 * 3600_000)
    expect(await notifCount(`reservation:${s.reservationId}:no_show_extended`)).toBe(1)
  })

  it('over the API: reason mandatory (422), Reception 403, other site 404; a cancelled reservation cannot be extended', async () => {
    const s = await reserved()
    const rec = await who('Rec', { siteIds: [s.siteId] })
    const outsider = await who('AA', { siteIds: [(await mkProperty()).siteId] })
    expect((await call(extendRoute, { cookie: await s.aa.cookie(), params: { id: s.reservationId }, body: {} })).status).toBe(422)
    expect((await call(extendRoute, { cookie: await rec.cookie(), params: { id: s.reservationId }, body: { reason: 'please' } })).status).toBe(403)
    expect((await call(extendRoute, { cookie: await outsider.cookie(), params: { id: s.reservationId }, body: { reason: 'please' } })).status).toBe(404)
    expect((await row(s.reservationId)).no_show_extended).toBe(false)
    must(await cancelReservation(s.aa.rc, { reservationId: s.reservationId, reason: 'gone' }))
    expect((await extendNoShow(s.aa.rc, { reservationId: s.reservationId, reason: 'too late' })).ok).toBe(false)
  })
})

describe('reservation list and detail are scoped by reservations_stays.view', () => {
  it('AA sees their sites, a Resident sees only their own reservation, Reception sees the site; a stranger gets nothing', async () => {
    const a = await reserved()
    const b = await reserved()
    const res = await who('Res')
    const own = await mkProperty({ beds: 1 })
    await admin().query(`UPDATE staff_profile SET gender = 'male' WHERE id = $1`, [res.staffId])
    const reqId = await mkRequest({ staffId: res.staffId, siteId: own.siteId, arrival: day(6), end: day(16) })
    const aaOwn = await who('AA', { siteIds: [own.siteId] })
    const mine = must(await approveRequest(aaOwn.rc, { requestId: reqId, bedId: own.bedIds[0] }))

    const idsFor = async (w: { rc: { actor: any } }) => (await listReservations(getDb(), w.rc.actor, { limit: 100 })).items.map(i => i.id)
    expect(await idsFor(a.aa)).toContain(a.reservationId)
    expect(await idsFor(a.aa)).not.toContain(b.reservationId)
    expect(await idsFor(res)).toEqual([mine.reservationId])
    const rec = await who('Rec', { siteIds: [a.siteId] })
    expect(await idsFor(rec)).toContain(a.reservationId)
    expect(await getReservation(getDb(), a.aa.rc.actor, b.reservationId)).toBeUndefined() // other site: not found
    expect(await getReservation(getDb(), res.rc.actor, a.reservationId)).toBeUndefined() // someone else's: not found
    const detail = (await getReservation(getDb(), res.rc.actor, mine.reservationId))!
    expect(detail.from).toBe(day(6))
    expect(detail.to).toBe(day(16))
    expect(detail.can.cancel).toBe(false) // a resident has no manage right
    expect((await reservationsOf(reqId))).toHaveLength(1)
  })
})
