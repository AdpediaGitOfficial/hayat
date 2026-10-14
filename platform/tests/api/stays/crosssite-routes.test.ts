/** D-104 through the real route handlers: the request form's data, the transfer list for both sites, scope, and the approve/execute round trip. */
import { afterAll, describe, expect, it } from 'vitest'
import { admin, call, closeAll } from '../harness'
import { actor, mkProperty, setConfigValue } from '../fixtures2'
import { day, mkStay, setBedState, stayRow } from './helpers'
import { GET as optionsRoute } from '../../../app/api/v1/stays/[id]/transfer-options/route'
import { POST as transferRoute } from '../../../app/api/v1/stays/[id]/transfer/route'
import { GET as transfersRoute } from '../../../app/api/v1/stays/transfers/route'
import { POST as approveRoute } from '../../../app/api/v1/stays/transfers/[id]/approve/route'
import { POST as executeRoute } from '../../../app/api/v1/stays/transfers/[id]/execute/route'

afterAll(closeAll)

type A = Awaited<ReturnType<typeof actor>>
const get = (h: Parameters<typeof call>[0], a: A | undefined, o: { id?: string; path?: string } = {}) => call(h, { cookie: a?.cookie, params: o.id ? { id: o.id } : undefined, path: o.path ?? '/api/v1/stays/x' })
const post = (h: Parameters<typeof call>[0], a: A | undefined, body: unknown, id?: string) => call(h, { method: 'POST', body, cookie: a?.cookie, params: id ? { id } : undefined, path: '/api/v1/stays/x' })

async function scene() {
  const src = await mkProperty({ beds: 2 }), dst = await mkProperty({ beds: 3 }), third = await mkProperty({ beds: 1 })
  await admin().query(`UPDATE site SET name = 'Palm Source' WHERE id = $1`, [src.siteId])
  await admin().query(`UPDATE site SET name = 'Marina Destination' WHERE id = $1`, [dst.siteId])
  const [aaS, aaD, aaS2, aaT, recD] = [await actor('AA', { siteIds: [src.siteId] }), await actor('AA', { siteIds: [dst.siteId] }), await actor('AA', { siteIds: [src.siteId] }), await actor('AA', { siteIds: [third.siteId] }), await actor('Rec', { siteIds: [dst.siteId] })]
  const res = await actor('Res')
  const stranger = await actor('Res')
  const stay = await mkStay({ bedId: src.bedIds[0], staffId: res.user.staffId, from: day(-5), to: day(30) })
  return { src, dst, third, aaS, aaD, aaS2, aaT, recD, res, stranger, ...stay }
}

describe('the destination options (what the request form shows)', () => {
  it('lists the destination site\'s ready beds free for the rest of the stay, with eligibility in plain words and nothing about other people', async () => {
    const sc = await scene()
    await admin().query(`UPDATE staff_profile SET gender = 'male' WHERE id = $1`, [sc.res.user.staffId])
    const femaleRoom = (await admin().query<{ id: string }>(`INSERT INTO room (site_id, name, gender_policy) VALUES ($1, 'Women only', 'female') RETURNING id`, [sc.dst.siteId])).rows[0].id
    const femaleBed = (await admin().query<{ id: string }>(`INSERT INTO bed (site_id, room_id, code) VALUES ($1, $2, 'W1') RETURNING id`, [sc.dst.siteId, femaleRoom])).rows[0].id
    await setBedState(sc.dst.bedIds[2], 'blocked') // a blocked bed is not offered

    const r = await get(optionsRoute, sc.res, { id: sc.stayId, path: `/api/v1/stays/x/transfer-options?siteId=${sc.dst.siteId}` })
    expect(r.status).toBe(200)
    expect(r.body.data).toMatchObject({ siteId: sc.dst.siteId, siteName: 'Marina Destination', current: false })
    const beds = r.body.data.beds as { bedId: string; code: string; eligible: boolean; hint: string | null }[]
    const w = beds.find(b => b.bedId === femaleBed)!
    expect(w).toMatchObject({ eligible: false })
    expect(w.hint).toMatch(/female-only/)
    expect(beds.find(b => b.bedId === sc.dst.bedIds[2])).toBeUndefined()
    expect(beds.some(b => b.eligible)).toBe(true)
    expect(beds[0].eligible).toBe(true) // eligible beds first
    expect(Object.keys(beds[0]).sort()).toEqual(['bedId', 'code', 'eligible', 'hint', 'roomName'])
  })

  it('is for whoever may ask for the move: the resident, the source site\'s admin; a stranger, the third site\'s admin and a signed-out caller get nothing; an archived or unknown site is "not found"', async () => {
    const sc = await scene()
    const path = `/api/v1/stays/x/transfer-options?siteId=${sc.dst.siteId}`
    expect((await get(optionsRoute, sc.aaS, { id: sc.stayId, path })).status).toBe(200)
    expect((await get(optionsRoute, sc.stranger, { id: sc.stayId, path })).status).toBe(404)
    expect((await get(optionsRoute, sc.aaT, { id: sc.stayId, path })).status).toBe(404)
    expect((await get(optionsRoute, sc.aaD, { id: sc.stayId, path })).status).toBe(404) // the destination admin has no say over this stay yet
    expect((await get(optionsRoute, undefined, { id: sc.stayId, path })).status).toBe(401)
    expect((await get(optionsRoute, sc.res, { id: sc.stayId, path: '/api/v1/stays/x/transfer-options' })).status).toBe(404)
    expect((await get(optionsRoute, sc.res, { id: sc.stayId, path: '/api/v1/stays/x/transfer-options?siteId=nope' })).status).toBe(404)
    await admin().query(`UPDATE site SET archived_at = now() WHERE id = $1`, [sc.third.siteId])
    expect((await get(optionsRoute, sc.res, { id: sc.stayId, path: `/api/v1/stays/x/transfer-options?siteId=${sc.third.siteId}` })).status).toBe(404)
  })

  it('the destination site\'s own rules show up in the hints (a minimum grade there)', async () => {
    const sc = await scene()
    await admin().query(`UPDATE staff_profile SET grade = 4 WHERE id = $1`, [sc.res.user.staffId])
    await setConfigValue('eligibility.min_grade', 7, sc.dst.siteId)
    const r = await get(optionsRoute, sc.res, { id: sc.stayId, path: `/api/v1/stays/x/transfer-options?siteId=${sc.dst.siteId}` })
    const beds = r.body.data.beds as { eligible: boolean; hint: string | null }[]
    expect(beds.length).toBeGreaterThan(0)
    expect(beds.every(b => !b.eligible && /needs grade 7\+/.test(b.hint ?? ''))).toBe(true)
  })
})

describe('request, list, approve and execute through the API', () => {
  it('a full cross-site journey: the resident asks, each site sees the same request with its own key, both approve, Reception executes, the stay is now the destination\'s', async () => {
    const sc = await scene()
    const asked = await post(transferRoute, sc.res, { destinationSiteId: sc.dst.siteId, destinationBedId: null, reason: 'Moving to the Marina project' }, sc.stayId)
    expect(asked.status).toBe(200)
    expect(asked.body.data).toMatchObject({ status: 'requested', crossSite: true })
    const id = asked.body.data.id as string

    const row = async (a: A) => ((await get(transfersRoute, a, { path: '/api/v1/stays/transfers?status=open' })).body.data as any[]).find(t => t.id === id)
    // what each person sees
    const asSrc = await row(sc.aaS)
    expect(asSrc).toMatchObject({ crossSite: true, siteName: 'Palm Source', destinationSiteName: 'Marina Destination', status: 'requested' })
    expect(asSrc.waiting.text).toBe('Waiting for the Accommodation Admin of Palm Source and the Accommodation Admin of Marina Destination')
    expect(asSrc.waiting.owner).toMatch(/Palm Source.*Marina Destination/)
    expect(asSrc.waiting.next).toMatch(/both sites/)
    expect(asSrc.can).toMatchObject({ approve: true, chooseBed: false })
    expect(asSrc.keys.source).toMatchObject({ approved: false, viewerCanGive: true })
    expect(asSrc.keys.destination).toMatchObject({ approved: false, viewerCanGive: false })
    const asDst = await row(sc.aaD)
    expect(asDst).toBeDefined()
    expect(asDst.can).toMatchObject({ approve: true, chooseBed: true })
    expect(asDst.keys.destination.viewerCanGive).toBe(true)
    expect(asDst.suggestions.length).toBeGreaterThan(0) // beds of the DESTINATION site, for the admin who will choose
    expect(new Set((await admin().query<{ site_id: string }>(`SELECT site_id FROM bed WHERE id = ANY($1::uuid[])`, [asDst.suggestions.map((s: any) => s.bedId)])).rows.map(r => r.site_id))).toEqual(new Set([sc.dst.siteId]))
    expect(asSrc.suggestions).toEqual([]) // not needed on the source side
    expect(asDst.name).toBe(asSrc.name) // the admin of the site they move INTO may see who is coming
    expect(await row(sc.aaT)).toBeUndefined()
    expect(await row(sc.stranger)).toBeUndefined()
    const asRes = await row(sc.res)
    expect(asRes).toMatchObject({ id, can: { approve: false, execute: false, cancel: true } })

    // source key
    expect((await post(approveRoute, sc.aaS2, { destinationBedId: null }, id)).body.data).toMatchObject({ status: 'requested', keys: { source: true, destination: false } })
    const afterSrc = await row(sc.aaD)
    expect(afterSrc.waiting.text).toBe('Waiting for the Accommodation Admin of Marina Destination')
    expect(afterSrc.keys.source.approved).toBe(true)
    expect((await post(executeRoute, sc.recD, {}, id)).status).toBe(409) // not yet: reason, owner and next action in the body
    const early = await post(executeRoute, sc.recD, {}, id)
    expect(early.body).toMatchObject({ ok: false })
    expect(early.body.reason).toContain('Accommodation Admin of Marina Destination')
    expect(early.body.owner).toBeTruthy()
    expect(early.body.next).toBeTruthy()
    // destination key, choosing the bed
    const bed = asDst.suggestions[0].bedId as string
    expect((await post(approveRoute, sc.aaD, { destinationBedId: bed }, id)).body.data).toMatchObject({ status: 'approved' })
    const approved = await row(sc.aaS)
    expect(approved.waiting).toMatchObject({ owner: 'Reception' })
    expect(approved.can.execute).toBe(true) // the policy lets an Accommodation Admin execute too (Reception: approved ones only); either site will do
    expect((await row(sc.recD)).can.execute).toBe(true)

    // execute (the destination site's Reception)
    const done = await post(executeRoute, sc.recD, {}, id)
    expect(done.status).toBe(200)
    expect(done.body.data).toMatchObject({ kind: 'transfer', status: 'executed' })
    expect((await stayRow(sc.stayId)).bed_id).toBe(bed)
    // the history stays visible to both sites and the resident
    const closed = async (a: A) => ((await get(transfersRoute, a, { path: '/api/v1/stays/transfers?status=executed' })).body.data as any[]).find(t => t.id === id)
    for (const a of [sc.aaS, sc.aaD, sc.res]) expect(await closed(a)).toMatchObject({ status: 'executed', crossSite: true })
    expect(await closed(sc.aaT)).toBeUndefined()
  })

  it('a destination bed in another site is stored with that site; a bed and a site that disagree are refused with the field to fix', async () => {
    const sc = await scene()
    const bad = await post(transferRoute, sc.res, { destinationSiteId: sc.src.siteId, destinationBedId: sc.dst.bedIds[0], reason: 'Moving across' }, sc.stayId)
    expect(bad.status).toBe(422)
    expect(bad.body.fields).toHaveProperty('destinationBedId')
    const ok = await post(transferRoute, sc.res, { destinationBedId: sc.dst.bedIds[0], reason: 'Closer to work' }, sc.stayId)
    expect(ok.status).toBe(200)
    expect((await admin().query(`SELECT destination_site_id FROM transfer_request WHERE id = $1`, [ok.body.data.id])).rows[0].destination_site_id).toBe(sc.dst.siteId)
  })
})
