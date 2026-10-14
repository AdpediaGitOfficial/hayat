import { afterAll, describe, expect, it } from 'vitest'
import { admin, call, closeAll } from '../harness'
import { mkRequest, mkStaff, setConfigValue } from '../fixtures2'
import { audits, claimRow, cookieOf, entryRow, notes, offerRow, person, reservationCount, reservationsOf, window, world, HOUR } from './helpers'
import { setClock } from '@/server/runtime'
import { runCommand } from '@/server/command/run'
import { allocateBed } from '@/server/allocation'
import { addToWaitlist } from '@/server/commands/waitlist/add'
import { createOffer, offerToNext, withdrawOffer } from '@/server/commands/waitlist/offer'
import { confirmDelivery, viewOffer } from '@/server/commands/waitlist/delivery'
import { acceptOffer, acceptOfferOnBehalf, declineOffer } from '@/server/commands/waitlist/respond'
import { closeEntriesForStaff, withdrawOffersForStaff } from '@/server/commands/waitlist/close'
import { matchFreedBed, queuePosition } from '@/server/commands/waitlist/queue'
import { getDb } from '@/server/db/client'
import { GET as viewRoute } from '../../../app/api/v1/waitlist/offers/[id]/route'
import { POST as acceptRoute } from '../../../app/api/v1/waitlist/offers/[id]/accept/route'
import { POST as behalfRoute } from '../../../app/api/v1/waitlist/offers/[id]/accept-on-behalf/route'
import { POST as declineRoute } from '../../../app/api/v1/waitlist/offers/[id]/decline/route'
import { POST as deliveryRoute } from '../../../app/api/v1/waitlist/offers/[id]/delivery/route'
import { POST as offerRoute } from '../../../app/api/v1/waitlist/[id]/offer/route'
import { POST as nextRoute } from '../../../app/api/v1/waitlist/offer-next/route'

afterAll(closeAll)

type World = Awaited<ReturnType<typeof world>>
type Win = ReturnType<typeof window>

/** A site, an Accommodation Admin, Reception and a waiting resident with an account (and optionally a linked request). */
async function scene(o: { beds?: number; withRequest?: boolean; stayType?: 'contract' | 'trainee' | 'permanent' } = {}) {
  const w = await world({ beds: o.beds ?? 3 })
  const win = window()
  const requestId = o.withRequest ? await mkRequest({ staffId: w.res.staffId, siteId: w.siteId, arrival: win.day(5), end: win.day(65), status: 'pending_approval', stayType: o.stayType ?? 'contract' }) : undefined
  const e = await addToWaitlist(w.rec.rc(win.clock), { staffId: w.res.staffId, siteId: w.siteId, requestId, arrival: win.day(5), end: o.stayType === 'permanent' ? null : win.day(65) })
  if (!e.ok) throw new Error(e.reason)
  return { w, win, entryId: e.data.entryId, requestId }
}
/** Someone else waiting at the same site, joined `hoursLater` after (so queued behind). */
async function another(w: World, win: Win, hoursLater = 1) {
  win.clock.advance(hoursLater * HOUR)
  const r = await person('Res')
  const e = await addToWaitlist(w.rec.rc(win.clock), { staffId: r.staffId, siteId: w.siteId, arrival: win.day(5), end: win.day(65) })
  if (!e.ok) throw new Error(e.reason)
  return { r, entryId: e.data.entryId }
}
async function offer(w: World, win: Win, entryId: string, bedId: string, overrideReason?: string) {
  const r = await createOffer(w.aa.rc(win.clock), { entryId, bedId, overrideReason })
  if (!r.ok) throw new Error(`createOffer: ${r.reason}`)
  return r.data
}
const heldBy = (w: World, win: Win, bedId: string, staffId: string, from: string, to: string) =>
  runCommand(w.aa.rc(win.clock), c => allocateBed(c, { bedId, staffId, from, to, kind: 'reservation' }))

describe('creating an offer holds the bed', () => {
  it('the bed is held (nobody can allocate it), the entry is Offered, the 48 hours have NOT started, and the resident is told', async () => {
    const { w, win, entryId } = await scene()
    const o = await offer(w, win, entryId, w.bedIds[0])
    expect(o).toMatchObject({ created: true, from: win.day(5), to: win.day(65) })
    const row = await offerRow(o.offerId)
    expect(row).toMatchObject({ status: 'pending', delivered_at: null, delivered_via: null, expires_at: null, staff_id: w.res.staffId })
    expect((await claimRow(o.claimId)).kind).toBe('offer_hold')
    expect((await entryRow(entryId)).status).toBe('offered')
    // held: allocateBed answers bed_held, naming the owner and the next step
    const other = await mkStaff()
    const blocked = await heldBy(w, win, w.bedIds[0], other.id, win.day(10), win.day(20))
    expect(blocked.ok).toBe(false)
    if (!blocked.ok) { expect((blocked.detail as any).reason).toBe('bed_held'); expect(blocked.next).toMatch(/accepted, declined or to expire/) }
    // a hold does not block other beds, or the same bed for non-overlapping dates
    expect((await heldBy(w, win, w.bedIds[1], other.id, win.day(10), win.day(20))).ok).toBe(true)
    expect((await heldBy(w, win, w.bedIds[0], (await mkStaff()).id, win.day(65), win.day(80))).ok).toBe(true)
    const n = await notes(`offer:${o.offerId}:created`)
    expect(n).toHaveLength(1)
    expect(n[0]).toMatchObject({ to_staff_id: w.res.staffId })
    const a = await audits(o.offerId)
    expect(a[0]).toMatchObject({ action: 'waitlist.offer.created', actor_role: 'AA', actor_user_id: w.aa.user.id })
  })

  it('AT-030 retrying createOffer for the same entry and bed answers with the same offer: one claim, one offer, one notification', async () => {
    const { w, win, entryId } = await scene()
    const first = await offer(w, win, entryId, w.bedIds[0])
    const again = await createOffer(w.aa.rc(win.clock), { entryId, bedId: w.bedIds[0] })
    expect(again.ok).toBe(true)
    if (again.ok) expect(again.data).toMatchObject({ offerId: first.offerId, claimId: first.claimId, created: false })
    const both = await Promise.all([1, 2, 3].map(() => createOffer(w.aa.rc(win.clock), { entryId, bedId: w.bedIds[0] })))
    expect(both.every(x => x.ok)).toBe(true)
    expect(Number((await admin().query(`SELECT count(*) FROM bed_offer WHERE staff_id = $1`, [w.res.staffId])).rows[0].count)).toBe(1)
    expect(Number((await admin().query(`SELECT count(*) FROM bed_claim WHERE bed_id = $1 AND released_at IS NULL`, [w.bedIds[0]])).rows[0].count)).toBe(1)
    expect(await notes(`offer:${first.offerId}:created`)).toHaveLength(1)
  })

  it('one pending offer per person: a second bed is refused, and the database refuses it too', async () => {
    const { w, win, entryId } = await scene()
    const o = await offer(w, win, entryId, w.bedIds[0])
    const second = await createOffer(w.aa.rc(win.clock), { entryId, bedId: w.bedIds[1] })
    expect(second.ok).toBe(false)
    if (!second.ok) { expect(second.code).toBe('conflict'); expect((second.detail as any).reason).toBe('offer_pending') }
    // backstop: even a direct insert cannot create a second pending offer for the person
    const claim = (await admin().query(`INSERT INTO bed_claim (bed_id, kind, period) VALUES ($1, 'offer_hold', $2::daterange) RETURNING id`, [w.bedIds[1], `[${win.day(5)},${win.day(65)})`])).rows[0]
    await expect(admin().query(`INSERT INTO bed_offer (staff_id, bed_id, claim_id) VALUES ($1, $2, $3)`, [w.res.staffId, w.bedIds[1], claim.id])).rejects.toMatchObject({ code: '23505' })
    expect((await offerRow(o.offerId)).status).toBe('pending')
  })

  it('two admins offering the same bed to two people at once: exactly one wins and the loser is told what to do', async () => {
    const { w, win, entryId } = await scene()
    const b = await another(w, win)
    const rs = await Promise.all([
      createOffer(w.aa.rc(win.clock), { entryId, bedId: w.bedIds[0] }),
      createOffer(w.aa.rc(win.clock), { entryId: b.entryId, bedId: w.bedIds[0], overrideReason: 'urgent move-in' }),
    ])
    expect(rs.filter(x => x.ok)).toHaveLength(1)
    const lost = rs.find(x => !x.ok)
    expect(lost && !lost.ok && lost.next).toBeTruthy()
    expect(Number((await admin().query(`SELECT count(*) FROM bed_claim WHERE bed_id = $1 AND released_at IS NULL`, [w.bedIds[0]])).rows[0].count)).toBe(1)
  })

  it('queue order: the bed goes to the person ahead unless an admin overrides with a reason (audited)', async () => {
    const { w, win, entryId } = await scene()
    const behind = await another(w, win)
    const refused = await createOffer(w.aa.rc(win.clock), { entryId: behind.entryId, bedId: w.bedIds[0] })
    expect(refused.ok).toBe(false)
    if (!refused.ok) { expect((refused.detail as any).reason).toBe('ahead_in_queue'); expect((refused.detail as any).aheadEntryId).toBe(entryId) }
    expect(await offerRowsFor(behind.r.staffId)).toBe(0)
    const o = await offer(w, win, behind.entryId, w.bedIds[0], 'First in line is away until Friday')
    const a = (await audits(o.offerId))[0]
    expect(a.reason).toBe('First in line is away until Friday')
    expect(a.after.queueOverride).toMatchObject({ aheadEntryId: entryId, aheadPosition: 1 })
    // the person who was ahead is still waiting, in the same place
    expect(await queuePosition(getDb(), w.siteId, entryId)).toBe(1)
  })

  it('"offer to the next in queue": the head of the queue gets it; a skipped bed, an ineligible person or a person with a bed of their own is passed over', async () => {
    const { w, win, entryId } = await scene()
    const behind = await another(w, win)
    const next = await offerToNext(w.aa.rc(win.clock), { bedId: w.bedIds[0] })
    expect(next.ok).toBe(true)
    if (next.ok) expect(await offerRow(next.data.offerId)).toMatchObject({ staff_id: w.res.staffId })
    // the first person declines this bed (skipped for them); the next offer of THAT bed goes to the person behind
    const v = await viewAs(w, win, next.ok ? next.data.offerId : '')
    expect(v.ok).toBe(true)
    expect((await declineOffer(w.res.rc(win.clock), { offerId: next.ok ? next.data.offerId : '' })).ok).toBe(true)
    const m = await matchFreedBed(getDb(), w.bedIds[0], win.clock.now())
    expect(m?.entryId).toBe(behind.entryId)
    // but for another bed the person who declined is still first
    expect((await matchFreedBed(getDb(), w.bedIds[1], win.clock.now()))?.entryId).toBe(entryId)
    // a blocked bed matches nobody
    await admin().query(`UPDATE bed SET state = 'blocked' WHERE id = $1`, [w.bedIds[2]])
    expect(await matchFreedBed(getDb(), w.bedIds[2], win.clock.now())).toBeUndefined()
    const none = await offerToNext(w.aa.rc(win.clock), { bedId: w.bedIds[2] })
    expect(none.ok).toBe(false)
  })

  it('refusals: Reception cannot offer, an admin cannot offer to themselves, another site gets "not found", a bed at another site is refused, a declined bed is not re-offered', async () => {
    const { w, win, entryId } = await scene()
    const out = await world()
    const rec = await createOffer(w.rec.rc(win.clock), { entryId, bedId: w.bedIds[0] })
    expect(rec.ok).toBe(false)
    if (!rec.ok) expect(rec.code).toBe('forbidden')
    const elsewhere = await createOffer(out.aa.rc(win.clock), { entryId, bedId: w.bedIds[0] })
    expect(elsewhere.ok).toBe(false)
    if (!elsewhere.ok) expect(elsewhere.code).toBe('not_found')
    const wrongSite = await createOffer(w.aa.rc(win.clock), { entryId, bedId: out.bedIds[0] })
    expect(wrongSite.ok).toBe(false)
    if (!wrongSite.ok) expect(wrongSite.code).toBe('not_found') // the AA has no scope at the other site
    // the admin waiting for a bed cannot offer one to themselves (D-26)
    win.clock.advance(HOUR)
    const mine = await addToWaitlist(w.rec.rc(win.clock), { staffId: w.aa.staffId, siteId: w.siteId, arrival: win.day(5) })
    const self = await createOffer(w.aa.rc(win.clock), { entryId: mine.ok ? mine.data.entryId : '', bedId: w.bedIds[1], overrideReason: 'me first' })
    expect(self.ok).toBe(false)
    if (!self.ok) expect(self.code).toBe('separation_of_duties')
    // declined bed is skipped for that person
    const o = await offer(w, win, entryId, w.bedIds[0])
    await viewAs(w, win, o.offerId)
    await declineOffer(w.res.rc(win.clock), { offerId: o.offerId })
    const again = await createOffer(w.aa.rc(win.clock), { entryId, bedId: w.bedIds[0] })
    expect(again.ok).toBe(false)
    if (!again.ok) expect((again.detail as any).reason).toBe('bed_skipped')
    // a closed or expired entry cannot be offered a bed
    await admin().query(`UPDATE waitlist_entry SET expires_at = $2 WHERE id = $1`, [entryId, new Date(win.clock.nowMs() - 1000)])
    const old = await createOffer(w.aa.rc(win.clock), { entryId, bedId: w.bedIds[1] })
    expect(old.ok).toBe(false)
  })

  it('through the API: Accommodation Admin offers; Reception and residents are refused by the guard', async () => {
    const { w, win, entryId } = await scene()
    setClock(win.clock)
    const aa = await cookieOf(w.aa), rec = await cookieOf(w.rec), res = await cookieOf(w.res)
    expect((await call(offerRoute, { cookie: rec, body: { bedId: w.bedIds[0] }, params: { id: entryId } })).status).toBe(403)
    expect((await call(offerRoute, { cookie: res, body: { bedId: w.bedIds[0] }, params: { id: entryId } })).status).toBe(403)
    const ok = await call(offerRoute, { cookie: aa, body: { bedId: w.bedIds[0] }, params: { id: entryId } })
    expect(ok.status).toBe(200)
    expect(ok.body.data.created).toBe(true)
    const none = await call(nextRoute, { cookie: aa, body: { bedId: w.bedIds[1] } })
    expect(none.status).toBe(409) // the only person waiting already has an offer out
  })
})

async function offerRowsFor(staffId: string) {
  return Number((await admin().query(`SELECT count(*) FROM bed_offer WHERE staff_id = $1`, [staffId])).rows[0].count)
}
/** The resident opens the offer (confirmed delivery). */
const viewAs = (w: World, win: Win, offerId: string) => viewOffer(w.res.rc(win.clock), { offerId })

describe('delivery confirmation (D-49, D-51): the 48 hours start only when delivery is confirmed', () => {
  it('viewing the offer in the app starts the window, once; staff reading it start nothing', async () => {
    const { w, win, entryId } = await scene()
    const o = await offer(w, win, entryId, w.bedIds[0])
    // the Accommodation Admin and Reception reading it does not deliver it
    expect((await viewOffer(w.aa.rc(win.clock), { offerId: o.offerId })).ok).toBe(true)
    expect((await viewOffer(w.rec.rc(win.clock), { offerId: o.offerId })).ok).toBe(true)
    expect((await offerRow(o.offerId)).delivered_at).toBeNull()
    // the resident opens it
    win.clock.advance(5 * HOUR)
    const v = await viewAs(w, win, o.offerId)
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.data).toMatchObject({ status: 'pending', deliveredVia: 'viewed', canRespond: true, declines: 0, position: 1, bed: { id: w.bedIds[0] } })
    const row = await offerRow(o.offerId)
    expect(row.delivered_via).toBe('viewed')
    expect(row.delivered_at?.getTime()).toBe(win.clock.nowMs())
    expect(row.expires_at?.getTime()).toBe(win.clock.nowMs() + 48 * HOUR)
    expect((await audits(o.offerId)).filter(a => a.action === 'waitlist.offer.delivered')).toHaveLength(1)
    // opening it again changes nothing: the window is not restarted
    win.clock.advance(10 * HOUR)
    await viewAs(w, win, o.offerId)
    expect((await offerRow(o.offerId)).expires_at?.getTime()).toBe(row.expires_at?.getTime())
    expect(await notes(`offer:${o.offerId}:delivered`)).toHaveLength(1)
  })

  it('through the API: GET by the offered resident confirms delivery; another resident gets "not found"', async () => {
    const { w, win, entryId } = await scene()
    setClock(win.clock)
    const o = await offer(w, win, entryId, w.bedIds[0])
    const stranger = await person('Res')
    expect((await call(viewRoute, { cookie: await cookieOf(stranger), params: { id: o.offerId } })).status).toBe(404)
    expect((await offerRow(o.offerId)).delivered_at).toBeNull()
    const r = await call(viewRoute, { cookie: await cookieOf(w.res), params: { id: o.offerId } })
    expect(r.status).toBe(200)
    expect(r.body.data.deliveredVia).toBe('viewed')
    expect((await offerRow(o.offerId)).delivered_via).toBe('viewed')
  })

  it('"informed offline" by Reception needs a note and starts the window; email confirmation is a placeholder command; neither restarts an open window; never for oneself', async () => {
    const a = await scene()
    const o = await offer(a.w, a.win, a.entryId, a.w.bedIds[0])
    const noNote = await confirmDelivery(a.w.rec.rc(a.win.clock), { offerId: o.offerId, via: 'offline' })
    expect(noNote.ok).toBe(false)
    a.win.clock.advance(26 * HOUR)
    const r = await confirmDelivery(a.w.rec.rc(a.win.clock), { offerId: o.offerId, via: 'offline', note: 'Phoned at 14:10; will answer tonight' })
    expect(r.ok).toBe(true)
    const row = await offerRow(o.offerId)
    expect(row).toMatchObject({ delivered_via: 'offline' })
    expect(row.expires_at?.getTime()).toBe(a.win.clock.nowMs() + 48 * HOUR)
    const au = (await audits(o.offerId)).find(x => x.action === 'waitlist.offer.delivered')!
    expect(au).toMatchObject({ actor_role: 'Rec', reason: 'Phoned at 14:10; will answer tonight' })
    expect((await admin().query(`SELECT delivery_note, delivered_by FROM bed_offer WHERE id = $1`, [o.offerId])).rows[0]).toMatchObject({ delivery_note: 'Phoned at 14:10; will answer tonight', delivered_by: a.w.rec.user.id })
    a.win.clock.advance(HOUR)
    const email = await confirmDelivery(a.w.aa.rc(a.win.clock), { offerId: o.offerId, via: 'email' })
    expect(email.ok).toBe(true)
    expect((await offerRow(o.offerId)).delivered_via).toBe('offline') // first confirmation stands
    expect((await offerRow(o.offerId)).expires_at?.getTime()).toBe(row.expires_at?.getTime())

    // email on a fresh offer
    const b = await scene()
    const o2 = await offer(b.w, b.win, b.entryId, b.w.bedIds[0])
    expect((await confirmDelivery(b.w.rec.rc(b.win.clock), { offerId: o2.offerId, via: 'email' })).ok).toBe(false) // Reception: offline only
    expect((await confirmDelivery(b.w.aa.rc(b.win.clock), { offerId: o2.offerId, via: 'email' })).ok).toBe(true)
    expect((await offerRow(o2.offerId)).delivered_via).toBe('email')
    // the offered person cannot confirm their own delivery for staff
    const c = await scene()
    const o3 = await offer(c.w, c.win, c.entryId, c.w.bedIds[0])
    const self = await confirmDelivery(c.w.res.rc(c.win.clock), { offerId: o3.offerId, via: 'offline', note: 'I told myself' })
    expect(self.ok).toBe(false)
    expect((await offerRow(o3.offerId)).delivered_at).toBeNull()
    // other site
    const other = await world()
    const out = await confirmDelivery(other.rec.rc(c.win.clock), { offerId: o3.offerId, via: 'offline', note: 'not mine at all' })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.code).toBe('not_found')
    // API
    setClock(c.win.clock)
    const viaApi = await call(deliveryRoute, { cookie: await cookieOf(c.w.rec), body: { via: 'offline', note: 'told at the desk' }, params: { id: o3.offerId } })
    expect(viaApi.status).toBe(200)
    expect((await offerRow(o3.offerId)).delivered_via).toBe('offline')
  })
})

describe('accepting an offer', () => {
  it('the hold becomes the reservation in place: source offer, claim converted, entry closed, linked request approved; nobody else can take the bed meanwhile', async () => {
    const { w, win, entryId, requestId } = await scene({ withRequest: true, stayType: 'trainee' })
    const o = await offer(w, win, entryId, w.bedIds[0])
    await viewAs(w, win, o.offerId)
    win.clock.advance(HOUR)
    const r = await acceptOffer(w.res.rc(win.clock), { offerId: o.offerId })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data).toMatchObject({ bedId: w.bedIds[0], claimId: o.claimId, from: win.day(5), to: win.day(65), onBehalf: false, repeated: false })
    const res = (await reservationsOf(w.res.staffId))[0]
    expect(res).toMatchObject({ id: r.data.reservationId, bed_id: w.bedIds[0], claim_id: o.claimId, status: 'reserved', source: 'offer', stay_type: 'trainee', request_id: requestId, created_by: w.res.user.id })
    expect(res.eta.toISOString()).toBe(`${win.day(5)}T12:00:00.000Z`)
    const claim = await claimRow(o.claimId)
    expect(claim).toMatchObject({ kind: 'reservation', released_at: null })
    expect(claim.period).toBe(`[${win.day(5)},${win.day(65)})`)
    expect(await entryRow(entryId)).toMatchObject({ status: 'closed', close_reason: 'offer_accepted' })
    expect(await offerRow(o.offerId)).toMatchObject({ status: 'accepted', accepted_by: w.res.user.id, accepted_on_behalf: false })
    expect((await admin().query(`SELECT status, decided_by, decision_reason FROM accommodation_request WHERE id = $1`, [requestId])).rows[0]).toMatchObject({ status: 'approved', decided_by: w.aa.user.id, decision_reason: 'Bed offer accepted' })
    // the bed is still taken (never free in between)
    const blocked = await heldBy(w, win, w.bedIds[0], (await mkStaff()).id, win.day(10), win.day(20))
    expect(blocked.ok).toBe(false)
    if (!blocked.ok) expect((blocked.detail as any).reason).toBe('bed_taken')
    expect((await audits(o.offerId)).some(a => a.action === 'waitlist.offer.accepted')).toBe(true)
    expect(await notes(`offer:${o.offerId}:accepted`)).toHaveLength(2) // resident + Reception
  })

  it('AT-030 retries: accepting again (sequentially or at the same instant) creates no second reservation and no second notification', async () => {
    const { w, win, entryId } = await scene()
    const o = await offer(w, win, entryId, w.bedIds[0])
    await viewAs(w, win, o.offerId)
    const rs = await Promise.all([1, 2, 3].map(() => acceptOffer(w.res.rc(win.clock), { offerId: o.offerId })))
    expect(rs.every(x => x.ok)).toBe(true)
    const ids = new Set(rs.map(x => (x.ok ? x.data.reservationId : '')))
    expect(ids.size).toBe(1)
    expect(await reservationCount(w.res.staffId)).toBe(1)
    const again = await acceptOffer(w.res.rc(win.clock), { offerId: o.offerId })
    expect(again.ok && again.data.repeated).toBe(true)
    expect(await reservationCount(w.res.staffId)).toBe(1)
    expect(await notes(`offer:${o.offerId}:accepted`)).toHaveLength(2)
    expect((await audits(o.offerId)).filter(a => a.action === 'waitlist.offer.accepted')).toHaveLength(1)
  })

  it('through the API; a different resident gets "not found"; staff cannot accept in the resident\'s name through this door', async () => {
    const { w, win, entryId } = await scene()
    setClock(win.clock)
    const o = await offer(w, win, entryId, w.bedIds[0])
    const stranger = await person('Res')
    expect((await call(acceptRoute, { cookie: await cookieOf(stranger), body: {}, params: { id: o.offerId } })).status).toBe(404)
    expect((await call(acceptRoute, { cookie: await cookieOf(w.rec), body: {}, params: { id: o.offerId } })).status).toBe(403)
    const r = await call(acceptRoute, { cookie: await cookieOf(w.res), body: {}, params: { id: o.offerId } })
    expect(r.status).toBe(200)
    expect(await reservationCount(w.res.staffId)).toBe(1)
    // accepting without having opened it first still counts as delivery
    expect((await offerRow(o.offerId)).delivered_via).toBe('viewed')
  })

  it('revalidated on accept: a person who stopped being eligible, or who got a reservation elsewhere, cannot accept; the offer stays for the admin to resolve', async () => {
    const a = await scene()
    const o = await offer(a.w, a.win, a.entryId, a.w.bedIds[0])
    await setConfigValue('eligibility.min_grade', 9, a.w.siteId)
    const r = await acceptOffer(a.w.res.rc(a.win.clock), { offerId: o.offerId })
    expect(r.ok).toBe(false)
    if (!r.ok) { expect((r.detail as any).reason).toBe('not_eligible'); expect(r.owner).toBe('Policy Approver') }
    expect(await reservationCount(a.w.res.staffId)).toBe(0)
    expect((await offerRow(o.offerId)).status).toBe('pending')
    expect((await claimRow(o.claimId)).kind).toBe('offer_hold')
    await setConfigValue('eligibility.min_grade', 0, a.w.siteId)

    const b = await scene()
    const o2 = await offer(b.w, b.win, b.entryId, b.w.bedIds[0])
    const claim = (await admin().query(`INSERT INTO bed_claim (bed_id, kind, period) VALUES ($1, 'reservation', $2::daterange) RETURNING id`, [b.w.bedIds[1], `[${b.win.day(100)},${b.win.day(110)})`])).rows[0]
    await admin().query(`INSERT INTO reservation (staff_id, bed_id, claim_id, eta, source, stay_type) VALUES ($1, $2, $3, now(), 'request', 'contract')`, [b.w.res.staffId, b.w.bedIds[1], claim.id])
    const r2 = await acceptOffer(b.w.res.rc(b.win.clock), { offerId: o2.offerId })
    expect(r2.ok).toBe(false)
    if (!r2.ok) expect((r2.detail as any).reason).toBe('already_housed')
  })

  it('after the 48 hours have ended (even before the sweep has run) it can no longer be accepted or declined', async () => {
    const { w, win, entryId } = await scene()
    const o = await offer(w, win, entryId, w.bedIds[0])
    await viewAs(w, win, o.offerId)
    win.clock.advance(48 * HOUR - 1000)
    const last = await acceptOffer(w.res.rc(win.clock), { offerId: o.offerId })
    expect(last.ok).toBe(true) // the last second still counts
    const b = await scene()
    const o2 = await offer(b.w, b.win, b.entryId, b.w.bedIds[0])
    await viewAs(b.w, b.win, o2.offerId)
    b.win.clock.advance(48 * HOUR)
    const late = await acceptOffer(b.w.res.rc(b.win.clock), { offerId: o2.offerId })
    expect(late.ok).toBe(false)
    if (!late.ok) expect((late.detail as any).reason).toBe('offer_expired')
    expect((await declineOffer(b.w.res.rc(b.win.clock), { offerId: o2.offerId })).ok).toBe(false)
    expect(await reservationCount(b.w.res.staffId)).toBe(0)
    expect((await offerRow(o2.offerId)).status).toBe('pending') // only the sweep (or a person) ends it
  })
})

describe('accepting on behalf of the resident (D-52)', () => {
  it('Reception records the consent; the actor, the consent and the on-behalf flag are on the offer, the reservation and the audit', async () => {
    const { w, win, entryId } = await scene()
    const o = await offer(w, win, entryId, w.bedIds[0])
    win.clock.advance(25 * HOUR)
    const noConsent = await acceptOfferOnBehalf(w.rec.rc(win.clock), { offerId: o.offerId, consent: '' })
    expect(noConsent.ok).toBe(false)
    const r = await acceptOfferOnBehalf(w.rec.rc(win.clock), { offerId: o.offerId, consent: 'Spoke to Rahul at the desk at 10:05; he agreed' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.onBehalf).toBe(true)
    const row = (await admin().query(`SELECT status, accepted_by, accepted_on_behalf, consent_note, delivered_via, delivered_by FROM bed_offer WHERE id = $1`, [o.offerId])).rows[0]
    expect(row).toMatchObject({ status: 'accepted', accepted_by: w.rec.user.id, accepted_on_behalf: true, consent_note: 'Spoke to Rahul at the desk at 10:05; he agreed', delivered_via: 'offline', delivered_by: w.rec.user.id })
    expect((await reservationsOf(w.res.staffId))[0]).toMatchObject({ source: 'offer', created_by: w.rec.user.id })
    const a = (await audits(o.offerId)).find(x => x.action === 'waitlist.offer.accepted_on_behalf')!
    expect(a).toMatchObject({ actor_role: 'Rec', actor_user_id: w.rec.user.id, reason: 'Spoke to Rahul at the desk at 10:05; he agreed' })
    expect(a.after).toMatchObject({ onBehalf: true, acceptedBy: w.rec.user.id })
    // the resident is told it was done for them
    expect((await notes(`offer:${o.offerId}:accepted`))[0].text).toMatch(/with your consent/)
    // repeating is harmless
    const again = await acceptOfferOnBehalf(w.rec.rc(win.clock), { offerId: o.offerId, consent: 'Spoke to Rahul at the desk at 10:05; he agreed' })
    expect(again.ok && again.data.repeated).toBe(true)
    expect(await reservationCount(w.res.staffId)).toBe(1)
  })

  it('the Accommodation Admin may too; a different site, the resident themselves and an admin for their own offer may not', async () => {
    const a = await scene()
    const o = await offer(a.w, a.win, a.entryId, a.w.bedIds[0])
    const out = await world()
    const elsewhere = await acceptOfferOnBehalf(out.rec.rc(a.win.clock), { offerId: o.offerId, consent: 'told by phone' })
    expect(elsewhere.ok).toBe(false)
    if (!elsewhere.ok) expect(elsewhere.code).toBe('not_found')
    const self = await acceptOfferOnBehalf(a.w.res.rc(a.win.clock), { offerId: o.offerId, consent: 'I consent to myself' })
    expect(self.ok).toBe(false)
    if (!self.ok) expect(self.code).toBe('forbidden')
    expect(await reservationCount(a.w.res.staffId)).toBe(0)
    expect((await acceptOfferOnBehalf(a.w.aa.rc(a.win.clock), { offerId: o.offerId, consent: 'Confirmed by email thread 22 Oct' })).ok).toBe(true)

    // an admin who is themselves the offered person
    const b = await scene()
    const adminRes = await person('AA', { siteIds: [b.w.siteId] })
    b.win.clock.advance(HOUR)
    const mine = await addToWaitlist(b.w.rec.rc(b.win.clock), { staffId: adminRes.staffId, siteId: b.w.siteId, arrival: b.win.day(5), end: b.win.day(65) })
    const other = await offer(b.w, b.win, b.entryId, b.w.bedIds[0])
    await withdrawOffer(b.w.aa.rc(b.win.clock), { offerId: other.offerId, reason: 'freeing the first bed' })
    const o2 = await createOffer(b.w.aa.rc(b.win.clock), { entryId: mine.ok ? mine.data.entryId : '', bedId: b.w.bedIds[1], overrideReason: 'test' })
    // the AA is the one offered, so a different admin created it
    expect(o2.ok).toBe(true)
    const own = await acceptOfferOnBehalf(adminRes.rc(b.win.clock), { offerId: o2.ok ? o2.data.offerId : '', consent: 'I agree with myself' })
    expect(own.ok).toBe(false)
    if (!own.ok) expect(own.code).toBe('separation_of_duties')
    // API
    setClock(a.win.clock)
    const b2 = await scene()
    const o3 = await offer(b2.w, b2.win, b2.entryId, b2.w.bedIds[0])
    setClock(b2.win.clock)
    expect((await call(behalfRoute, { cookie: await cookieOf(b2.w.rec), body: {}, params: { id: o3.offerId } })).status).toBe(422)
    expect((await call(behalfRoute, { cookie: await cookieOf(b2.w.rec), body: { consent: 'phoned and agreed' }, params: { id: o3.offerId } })).status).toBe(200)
  })
})

describe('AT-012 first decline', () => {
  it('releases the hold, keeps the entry active with the queue position, skips that bed and counts one decline', async () => {
    const { w, win, entryId } = await scene()
    const behind = await another(w, win)
    const o = await offer(w, win, entryId, w.bedIds[0])
    await viewAs(w, win, o.offerId)
    const before = await entryRow(entryId)
    win.clock.advance(2 * HOUR)
    const r = await declineOffer(w.res.rc(win.clock), { offerId: o.offerId, reason: 'Prefer the other building' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data).toMatchObject({ declines: 1, requeued: false, positionBefore: 1, positionAfter: 1 })
    expect(await offerRow(o.offerId)).toMatchObject({ status: 'declined' })
    expect(await claimRow(o.claimId)).toMatchObject({ release_reason: 'offer_declined' })
    expect((await claimRow(o.claimId)).released_at).not.toBeNull()
    const e = await entryRow(entryId)
    expect(e).toMatchObject({ status: 'waiting', declines: 1, skip_bed_ids: [w.bedIds[0]] })
    expect(e.queue_ts.getTime()).toBe(before.queue_ts.getTime())
    expect(await queuePosition(getDb(), w.siteId, entryId)).toBe(1)
    expect(await queuePosition(getDb(), w.siteId, behind.entryId)).toBe(2)
    // the bed is free again for anybody
    expect((await heldBy(w, win, w.bedIds[0], (await mkStaff()).id, win.day(5), win.day(10))).ok).toBe(true)
    const a = (await audits(o.offerId)).find(x => x.action === 'waitlist.offer.declined')!
    expect(a.after).toMatchObject({ declines: 1, requeued: false, priorSequence: 1, newSequence: 1 })
    expect((await notes(`offer:${o.offerId}:declined`))[0].text).toMatch(/first decline, so you keep your place/)
    // declining twice changes nothing more
    const dup = await declineOffer(w.res.rc(win.clock), { offerId: o.offerId })
    expect(dup.ok && dup.data.repeated).toBe(true)
    expect((await entryRow(entryId)).declines).toBe(1)
  })

  it('through the API; a stranger gets "not found"', async () => {
    const { w, win, entryId } = await scene()
    setClock(win.clock)
    const o = await offer(w, win, entryId, w.bedIds[0])
    expect((await call(declineRoute, { cookie: await cookieOf(await person('Res')), body: {}, params: { id: o.offerId } })).status).toBe(404)
    const r = await call(declineRoute, { cookie: await cookieOf(w.res), body: { reason: 'No thanks' }, params: { id: o.offerId } })
    expect(r.status).toBe(200)
    expect(r.body.data).toMatchObject({ declines: 1, requeued: false })
  })
})

describe('AT-013 second decline', () => {
  it('moves the entry to the back of the queue; the audit records the prior and the new sequence number', async () => {
    const { w, win, entryId } = await scene()
    const second = await another(w, win, 1)
    const third = await another(w, win, 1)
    expect(await queuePosition(getDb(), w.siteId, entryId)).toBe(1)

    const o1 = await offer(w, win, entryId, w.bedIds[0])
    await viewAs(w, win, o1.offerId)
    expect((await declineOffer(w.res.rc(win.clock), { offerId: o1.offerId })).ok).toBe(true)
    expect(await queuePosition(getDb(), w.siteId, entryId)).toBe(1) // still first

    win.clock.advance(3 * HOUR)
    const o2 = await offer(w, win, entryId, w.bedIds[1])
    await viewAs(w, win, o2.offerId)
    win.clock.advance(HOUR)
    const r = await declineOffer(w.res.rc(win.clock), { offerId: o2.offerId })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data).toMatchObject({ declines: 2, requeued: true, positionBefore: 1, positionAfter: 3 })
    const e = await entryRow(entryId)
    expect(e).toMatchObject({ status: 'waiting', declines: 2 })
    expect(e.skip_bed_ids.sort()).toEqual([w.bedIds[0], w.bedIds[1]].sort())
    expect(e.queue_ts.getTime()).toBe(win.clock.nowMs())
    expect([await queuePosition(getDb(), w.siteId, second.entryId), await queuePosition(getDb(), w.siteId, third.entryId), await queuePosition(getDb(), w.siteId, entryId)]).toEqual([1, 2, 3])
    const a = (await audits(o2.offerId)).find(x => x.action === 'waitlist.offer.declined_requeued')!
    expect(a.before).toMatchObject({ declines: 1, sequence: 1 })
    expect(a.after).toMatchObject({ declines: 2, requeued: true, priorSequence: 1, newSequence: 3 })
    expect((await notes(`offer:${o2.offerId}:declined`))[0].text).toMatch(/moved to the back of the queue \(position 3\)/)
    // the person behind is next for the freed bed (the AA is told, but no offer is created)
    expect((await matchFreedBed(getDb(), w.bedIds[1], win.clock.now()))?.entryId).toBe(second.entryId)
    expect(await offerRowsFor(second.r.staffId)).toBe(0)
    const freed = await notes(`waitlist:bed:${w.bedIds[1]}:offer:${o2.offerId}:declined`)
    expect(freed).toHaveLength(1)
    expect(freed[0]).toMatchObject({ to_role: 'AA', site_id: w.siteId })
    // the entry still lives until it expires, and a later decline also goes to the back
    expect((await entryRow(entryId)).expires_at.getTime()).toBeGreaterThan(win.clock.nowMs())
  })

  it('the limit is configuration (timers.max_declines_before_requeue): with 1 the very first decline requeues', async () => {
    const { w, win, entryId } = await scene()
    await another(w, win)
    await setConfigValue('timers.max_declines_before_requeue', 1)
    try {
      const o = await offer(w, win, entryId, w.bedIds[0])
      await viewAs(w, win, o.offerId)
      const r = await declineOffer(w.res.rc(win.clock), { offerId: o.offerId })
      expect(r.ok && r.data.requeued).toBe(true)
    } finally {
      await setConfigValue('timers.max_declines_before_requeue', 2)
    }
  })
})

describe('withdrawing an offer', () => {
  it('releases the hold, keeps the place and the decline count, needs a reason, and is repeatable; Reception cannot', async () => {
    const { w, win, entryId } = await scene()
    const o = await offer(w, win, entryId, w.bedIds[0])
    expect((await withdrawOffer(w.rec.rc(win.clock), { offerId: o.offerId, reason: 'mine now' })).ok).toBe(false)
    const out = await world()
    const elsewhere = await withdrawOffer(out.aa.rc(win.clock), { offerId: o.offerId, reason: 'not my site' })
    expect(elsewhere.ok).toBe(false)
    if (!elsewhere.ok) expect(elsewhere.code).toBe('not_found')
    expect((await withdrawOffer(w.aa.rc(win.clock), { offerId: o.offerId, reason: 'Booked by mistake' })).ok).toBe(true)
    expect(await offerRow(o.offerId)).toMatchObject({ status: 'withdrawn' })
    expect(await entryRow(entryId)).toMatchObject({ status: 'waiting', declines: 0, skip_bed_ids: [] })
    expect((await claimRow(o.claimId)).release_reason).toBe('offer_withdrawn')
    expect((await heldBy(w, win, w.bedIds[0], (await mkStaff()).id, win.day(5), win.day(9))).ok).toBe(true)
    expect((await withdrawOffer(w.aa.rc(win.clock), { offerId: o.offerId, reason: 'again' })).ok).toBe(true)
    expect((await audits(o.offerId)).filter(a => a.action === 'waitlist.offer.withdrawn')).toHaveLength(1)
    expect(await notes(`offer:${o.offerId}:withdrawn`)).toHaveLength(1)
    // an accepted offer cannot be withdrawn
    const b = await scene()
    const o2 = await offer(b.w, b.win, b.entryId, b.w.bedIds[0])
    await acceptOffer(b.w.res.rc(b.win.clock), { offerId: o2.offerId })
    expect((await withdrawOffer(b.w.aa.rc(b.win.clock), { offerId: o2.offerId, reason: 'too late' })).ok).toBe(false)
  })
})

describe('Stage 3 hooks (D-36): Mark as Left closes entries and withdraws offers', () => {
  it('closeEntriesForStaff closes the entry, withdraws the offer and its hold, and closes the linked request', async () => {
    const { w, win, entryId, requestId } = await scene({ withRequest: true })
    const o = await offer(w, win, entryId, w.bedIds[0])
    const n = await runCommand(w.aa.rc(win.clock), async c => { const k = await closeEntriesForStaff(c, w.res.staffId, 'employment_ended'); return { ok: true as const, data: k } })
    expect(n.ok && n.data).toBe(1)
    expect(await entryRow(entryId)).toMatchObject({ status: 'closed', close_reason: 'employment_ended' })
    expect(await offerRow(o.offerId)).toMatchObject({ status: 'withdrawn' })
    expect((await claimRow(o.claimId)).released_at).not.toBeNull()
    expect((await admin().query(`SELECT status FROM accommodation_request WHERE id = $1`, [requestId])).rows[0].status).toBe('closed')
    expect((await heldBy(w, win, w.bedIds[0], (await mkStaff()).id, win.day(5), win.day(9))).ok).toBe(true)
    const again = await runCommand(w.aa.rc(win.clock), async c => ({ ok: true as const, data: await closeEntriesForStaff(c, w.res.staffId, 'employment_ended') }))
    expect(again.ok && again.data).toBe(0)
  })

  it('withdrawOffersForStaff releases the hold and puts the entry back to Waiting; the Accommodation Admin hears who is next', async () => {
    const { w, win, entryId } = await scene()
    const behind = await another(w, win)
    const o = await offer(w, win, entryId, w.bedIds[0])
    const n = await runCommand(w.aa.rc(win.clock), async c => ({ ok: true as const, data: await withdrawOffersForStaff(c, w.res.staffId, 'employment_ended') }))
    expect(n.ok && n.data).toBe(1)
    expect(await offerRow(o.offerId)).toMatchObject({ status: 'withdrawn' })
    expect((await entryRow(entryId)).status).toBe('waiting')
    const hint = await notes(`waitlist:bed:${w.bedIds[0]}:offer:${o.offerId}:withdrawn`)
    expect(hint).toHaveLength(1)
    expect(hint[0].text).toContain('Next in the waitlist queue')
    expect(behind.entryId).toBeTruthy()
  })
})
