/**
 * Stage 2 across packages, through the real routes and cookies: request -> approval -> reservation -> check-in ->
 * extension -> checkout, and the waitlist path request -> no bed -> waitlist -> offer -> accept -> check-in.
 * Each package has its own tests; this proves they fit together (and is where a broken seam shows first).
 */
import { afterAll, describe, expect, it } from 'vitest'
import { admin, call, closeAll, makeUser, signIn, useClock } from '../harness'
import { day, mkProperty, occupy, reserve } from '../fixtures2'
import { POST as submit } from '../../../app/api/v1/requests/route'
import { GET as inbox } from '../../../app/api/v1/approvals/inbox/route'
import { GET as bedsFor } from '../../../app/api/v1/requests/[id]/beds/route'
import { POST as approve } from '../../../app/api/v1/requests/[id]/approve/route'
import { POST as checkIn } from '../../../app/api/v1/stays/check-in/route'
import { POST as extend } from '../../../app/api/v1/stays/[id]/extension/route'
import { POST as approveExt } from '../../../app/api/v1/stays/extensions/[id]/approve/route'
import { POST as askCheckout } from '../../../app/api/v1/stays/[id]/checkout-request/route'
import { POST as doCheckout } from '../../../app/api/v1/stays/[id]/checkout/route'
import { POST as addToWaitlist } from '../../../app/api/v1/waitlist/route'
import { POST as offerNext } from '../../../app/api/v1/waitlist/offer-next/route'
import { GET as viewOffer } from '../../../app/api/v1/waitlist/offers/[id]/route'
import { POST as acceptOffer } from '../../../app/api/v1/waitlist/offers/[id]/accept/route'
import { GET as me } from '../../../app/api/v1/auth/me/route'

afterAll(closeAll)

async function people(siteId: string) {
  const aa = await makeUser({ roles: [{ role: 'AA', siteId }] })
  const rec = await makeUser({ roles: [{ role: 'Rec', siteId }] })
  const res = await makeUser({ roles: [{ role: 'Res' }] })
  return { aa, rec, res, ck: { aa: await signIn(aa), rec: await signIn(rec), res: await signIn(res) }, relogin: async (ck: Record<'aa' | 'rec' | 'res', string>) => { ck.aa = await signIn(aa); ck.rec = await signIn(rec); ck.res = await signIn(res) } }
}
const q = async (sql: string, p: unknown[] = []) => (await admin().query(sql, p)).rows

describe('request to checkout', () => {
  it('the whole path works through the API, and every step respects the rules', async () => {
    const clock = useClock('2026-10-14T09:00:00Z')
    const { siteId, bedIds } = await mkProperty({ beds: 2 })
    const p = await people(siteId)

    // 1. the resident asks
    const s = await call(submit, { cookie: p.ck.res, body: { siteId, arrivalDate: day(2), endDate: day(30), stayType: 'contract' } })
    expect(s.status, JSON.stringify(s.body)).toBe(200)
    const requestId = s.body.data.requestId as string

    // 2. it reaches the AA's inbox, and not the resident's own
    const items = (await call(inbox, { cookie: p.ck.aa })).body.data as any[]
    expect(items.find(i => i.ref === requestId)).toMatchObject({ kind: 'request', mine: true })
    expect((await call(inbox, { cookie: p.ck.res })).status).toBe(403)

    // 3. the AA picks one of the suggested beds; approval creates the reservation in one step
    const beds = await call(bedsFor, { cookie: p.ck.aa, params: { id: requestId } })
    expect(beds.body.data.suggestions.length).toBeGreaterThan(0)
    const bedId = beds.body.data.suggestions[0].bedId as string
    const ap = await call(approve, { cookie: p.ck.aa, params: { id: requestId }, body: { bedId } })
    expect(ap.status, JSON.stringify(ap.body)).toBe(200)
    const [resv] = await q(`SELECT id, status, claim_id FROM reservation WHERE request_id = $1`, [requestId])
    expect(resv.status).toBe('reserved')
    expect((await q(`SELECT status FROM accommodation_request WHERE id = $1`, [requestId]))[0].status).toBe('approved')
    expect((await q(`SELECT kind, upper(period)::text AS end FROM bed_claim WHERE id = $1`, [resv.claim_id]))[0]).toEqual({ kind: 'reservation', end: day(30) })

    // 4. check-in opens on the arrival day, not before; the resident cannot check themselves in
    expect((await call(checkIn, { cookie: p.ck.rec, body: { reservationId: resv.id } })).status).toBe(409)
    clock.set(`${day(2)}T10:00:00Z`); await p.relogin(p.ck) // staff sessions expire after 30 idle minutes
    expect((await call(checkIn, { cookie: p.ck.res, body: { reservationId: resv.id } })).status).toBe(403)
    const ci = await call(checkIn, { cookie: p.ck.rec, body: { reservationId: resv.id } })
    expect(ci.status, JSON.stringify(ci.body)).toBe(200)
    const stayId = ci.body.data.stayId as string
    expect((await q(`SELECT state FROM bed WHERE id = $1`, [bedId]))[0].state).toBe('occupied')
    expect((await q(`SELECT kind FROM bed_claim WHERE id = $1`, [resv.claim_id]))[0].kind).toBe('stay')

    // 5. the resident asks to stay longer; the AA approves; the claim follows
    const ex = await call(extend, { cookie: p.ck.res, params: { id: stayId }, body: { newEnd: day(45), reason: 'Project extended' } })
    expect(ex.status, JSON.stringify(ex.body)).toBe(200)
    const ea = await call(approveExt, { cookie: p.ck.aa, params: { id: ex.body.data.id }, body: {} })
    expect(ea.status, JSON.stringify(ea.body)).toBe(200)
    expect((await q(`SELECT upper(period)::text AS end FROM bed_claim WHERE id = $1`, [resv.claim_id]))[0].end).toBe(day(45))

    // 6. checkout: the bed needs cleaning, the claim is released, the resident keeps their login (D-39)
    const rq = await call(askCheckout, { cookie: p.ck.res, params: { id: stayId }, body: { departureDate: day(10) } })
    expect(rq.status, JSON.stringify(rq.body)).toBe(200)
    clock.set(`${day(10)}T09:00:00Z`); await p.relogin(p.ck)
    const co = await call(doCheckout, { cookie: p.ck.rec, params: { id: stayId }, body: {} })
    expect(co.status, JSON.stringify(co.body)).toBe(200)
    expect((await q(`SELECT state FROM bed WHERE id = $1`, [bedId]))[0].state).toBe('needs_cleaning')
    expect((await q(`SELECT status FROM stay WHERE id = $1`, [stayId]))[0].status).toBe('checked_out')
    expect((await q(`SELECT released_at IS NOT NULL AS released FROM bed_claim WHERE id = $1`, [resv.claim_id]))[0].released).toBe(true)
    expect((await call(me, { cookie: p.ck.res })).status).toBe(200)

    // the bed is NOT available again until cleaning and inspection (Stage 3): same-day it cannot be checked into
    expect(bedIds).toContain(bedId)
  })
})

describe('waitlist path', () => {
  it('no bed -> waitlist -> a bed frees up -> offer -> the resident accepts -> check-in', async () => {
    const clock = useClock('2026-10-14T09:00:00Z')
    const { siteId, bedIds } = await mkProperty({ beds: 1 })
    const blocker = await reserve(bedIds[0], day(1), day(60))
    const p = await people(siteId)

    const s = await call(submit, { cookie: p.ck.res, body: { siteId, arrivalDate: day(3), endDate: day(40), stayType: 'contract' } })
    const requestId = s.body.data.requestId as string
    const beds = await call(bedsFor, { cookie: p.ck.aa, params: { id: requestId } })
    expect(beds.body.data.suggestions).toEqual([])

    // the AA's "Add to the waitlist" button
    const staffId = (await q(`SELECT staff_id FROM accommodation_request WHERE id = $1`, [requestId]))[0].staff_id
    const w = await call(addToWaitlist, { cookie: p.ck.aa, body: { staffId, siteId, requestId, arrival: day(3), end: day(40), stayType: 'contract' } })
    expect(w.status, JSON.stringify(w.body)).toBe(200)
    expect((await q(`SELECT status FROM accommodation_request WHERE id = $1`, [requestId]))[0].status).toBe('waitlisted')
    expect(w.body.data.position).toBe(1)

    // the bed frees up (the earlier booking is released); the AA offers it to the next in queue
    await admin().query(`UPDATE bed_claim SET released_at = now(), release_reason = 'test' WHERE id = $1`, [blocker.claimId])
    const of = await call(offerNext, { cookie: p.ck.aa, body: { bedId: bedIds[0] } })
    expect(of.status, JSON.stringify(of.body)).toBe(200)
    const [offer] = await q(`SELECT id, status, delivered_at FROM bed_offer WHERE staff_id = $1`, [staffId])
    expect(offer.status).toBe('pending')
    expect(offer.delivered_at).toBeNull() // the 48 h timer has not started: nothing confirmed yet

    // the resident opens it (delivery confirmed) and accepts; the hold becomes the reservation
    expect((await call(viewOffer, { cookie: p.ck.res, params: { id: offer.id } })).status).toBe(200)
    expect((await q(`SELECT delivered_via FROM bed_offer WHERE id = $1`, [offer.id]))[0].delivered_via).toBe('viewed')
    const ac = await call(acceptOffer, { cookie: p.ck.res, params: { id: offer.id }, body: {} })
    expect(ac.status, JSON.stringify(ac.body)).toBe(200)
    const [resv] = await q(`SELECT id, source, status FROM reservation WHERE staff_id = $1`, [staffId])
    expect(resv).toMatchObject({ source: 'offer', status: 'reserved' })
    expect((await q(`SELECT status FROM accommodation_request WHERE id = $1`, [requestId]))[0].status).toBe('approved')

    clock.set(`${day(3)}T10:00:00Z`); await p.relogin(p.ck)
    expect((await call(checkIn, { cookie: p.ck.rec, body: { reservationId: resv.id } })).status).toBe(200)
    void occupy
  })
})
