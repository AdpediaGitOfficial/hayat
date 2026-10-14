/** WP-F through the real route handlers: scope, the staff-data rule for names, and the approvals inbox. */
import { afterAll, describe, expect, it } from 'vitest'
import { call, closeAll } from '../harness'
import { actor, mkProperty } from '../fixtures2'
import { day, mkReservation, mkStay, person, residents, bedState, setBedState, stayRow, newClock, world } from './helpers'
import { GET as listStaysRoute } from '../../../app/api/v1/stays/route'
import { GET as stayRoute } from '../../../app/api/v1/stays/[id]/route'
import { GET as arrivalsRoute } from '../../../app/api/v1/stays/arrivals/route'
import { POST as checkInRoute } from '../../../app/api/v1/stays/check-in/route'
import { POST as bulkRoute } from '../../../app/api/v1/stays/check-in/bulk/route'
import { POST as extensionRoute } from '../../../app/api/v1/stays/[id]/extension/route'
import { POST as transferRoute } from '../../../app/api/v1/stays/[id]/transfer/route'
import { GET as transfersRoute } from '../../../app/api/v1/stays/transfers/route'
import { POST as approveRoute } from '../../../app/api/v1/stays/transfers/[id]/approve/route'
import { POST as executeRoute } from '../../../app/api/v1/stays/transfers/[id]/execute/route'
import { listInbox } from '@/server/approvals/inbox'
import { getDb } from '@/server/db/client'
import { requestTransfer } from '@/server/commands/stays/requestTransfer'
import { requestExtension } from '@/server/commands/stays/extension'
import { admin } from '../harness'

afterAll(closeAll)

/** An actor who is also the staff member of a given resident row: a signed-in resident with a stay. */
async function residentWithStay(bedId: string, from = day(-3), to: string | null = day(30)) {
  const a = await actor('Res')
  const s = await mkStay({ bedId, staffId: a.user.staffId, from, to })
  return { a, ...s }
}
const get = (h: Parameters<typeof call>[0], a: Awaited<ReturnType<typeof actor>> | undefined, o: { id?: string; path?: string } = {}) =>
  call(h, { cookie: a?.cookie, params: o.id ? { id: o.id } : undefined, path: o.path ?? '/api/v1/stays' })
const post = (h: Parameters<typeof call>[0], a: Awaited<ReturnType<typeof actor>> | undefined, body: unknown, id?: string) =>
  call(h, { method: 'POST', body, cookie: a?.cookie, params: id ? { id } : undefined, path: '/api/v1/stays/x' })

describe('stay lists and detail are scoped (reservations_stays.view)', () => {
  it('Reception and the Accommodation Admin see their sites\' stays only; a resident sees only their own; other sites read as not found', async () => {
    const a = await mkProperty({ beds: 2 })
    const b = await mkProperty({ beds: 1 })
    const recA = await actor('Rec', { siteIds: [a.siteId] })
    const aaB = await actor('AA', { siteIds: [b.siteId] })
    const mine = await residentWithStay(a.bedIds[0])
    const other = await residentWithStay(a.bedIds[1])
    const inB = await residentWithStay(b.bedIds[0])

    const asRec = await get(listStaysRoute, recA)
    expect(asRec.status).toBe(200)
    const ids = asRec.body.data.rows.map((r: { id: string }) => r.id)
    expect(ids).toEqual(expect.arrayContaining([mine.stayId, other.stayId]))
    expect(ids).not.toContain(inB.stayId)

    const asRes = await get(listStaysRoute, mine.a)
    expect(asRes.body.data.rows.map((r: { id: string }) => r.id)).toEqual([mine.stayId])

    expect((await get(stayRoute, recA, { id: mine.stayId })).status).toBe(200)
    expect((await get(stayRoute, recA, { id: inB.stayId })).status).toBe(404)
    expect((await get(stayRoute, aaB, { id: mine.stayId })).status).toBe(404)
    expect((await get(stayRoute, mine.a, { id: other.stayId })).status).toBe(404)
    expect((await get(stayRoute, mine.a, { id: 'not-a-uuid' })).status).toBe(404)
    expect((await get(stayRoute, undefined, { id: mine.stayId })).status).toBe(401)
  })

  it('the stay list carries the ending and overdue badges', async () => {
    const p = await mkProperty({ beds: 4 })
    const rec = await actor('Rec', { siteIds: [p.siteId] })
    const ok = await residentWithStay(p.bedIds[0], day(-3), day(60))
    const ending = await residentWithStay(p.bedIds[1], day(-3), day(5))
    const overdue = await residentWithStay(p.bedIds[2], day(-30), day(-2))
    const escalated = await residentWithStay(p.bedIds[3], day(-30), day(-6))
    const rows = (await get(listStaysRoute, rec)).body.data.rows as { id: string; flag: string; daysOver: number }[]
    const flag = (id: string) => rows.find(r => r.id === id)?.flag
    expect([flag(ok.stayId), flag(ending.stayId), flag(overdue.stayId), flag(escalated.stayId)]).toEqual(['ok', 'ending', 'overdue', 'escalated'])
    // the overdue stays are still active: the list never hides, moves or checks anyone out
    expect((await stayRow(escalated.stayId)).status).toBe('active')
    const only = (await call(listStaysRoute, { cookie: rec.cookie, path: '/api/v1/stays?flag=overdue' })).body.data.rows.map((r: { id: string }) => r.id)
    expect(only).toEqual(expect.arrayContaining([overdue.stayId, escalated.stayId]))
    expect(only).not.toContain(ok.stayId)
  })

  it('a Read-only Manager sees stays but no resident names (staff data stays with those who may look staff up)', async () => {
    const p = await mkProperty({ beds: 1 })
    const mgr = await actor('Mgr', { siteIds: [p.siteId] })
    const rec = await actor('Rec', { siteIds: [p.siteId] })
    const r = await residentWithStay(p.bedIds[0])
    const asMgr = (await get(listStaysRoute, mgr)).body.data.rows.find((x: { id: string }) => x.id === r.stayId)
    expect(asMgr).toMatchObject({ name: 'Resident', employeeId: '' })
    const asRec = (await get(listStaysRoute, rec)).body.data.rows.find((x: { id: string }) => x.id === r.stayId)
    expect(asRec.name).not.toBe('Resident')
  })
})

describe('check-in through the API', () => {
  it('Reception checks in (200); a resident is refused (403); Reception of another site gets 404; nothing changed for the refused', async () => {
    const w = await mkProperty({ beds: 2 })
    const other = await mkProperty({ beds: 1 })
    const rec = await actor('Rec', { siteIds: [w.siteId] })
    const recOther = await actor('Rec', { siteIds: [other.siteId] })
    const res = await actor('Res')
    const r = await mkReservation({ bedId: w.bedIds[0], staffId: (await residents(1))[0].staffId, from: day(0), to: day(20) })

    expect((await post(checkInRoute, res, { reservationId: r.reservationId })).status).toBe(403)
    expect((await post(checkInRoute, recOther, { reservationId: r.reservationId })).status).toBe(404)
    expect(await bedState(w.bedIds[0])).toBe('available')

    const ok = await post(checkInRoute, rec, { reservationId: r.reservationId })
    expect(ok.status).toBe(200)
    expect(ok.body.data.bedId).toBe(w.bedIds[0])
    const again = await post(checkInRoute, rec, { reservationId: r.reservationId })
    expect(again.status).toBe(409)
    expect(again.body.detail.reason).toBe('already_checked_in')
    expect(await post(checkInRoute, rec, { reservationId: 'nope' })).toMatchObject({ status: 422 })
  })

  it('the arrivals list and the bulk check-in answer per row', async () => {
    const w = await mkProperty({ beds: 2 })
    const rec = await actor('Rec', { siteIds: [w.siteId] })
    const [a, b] = await residents(2)
    const ra = await mkReservation({ bedId: w.bedIds[0], staffId: a.staffId, from: day(0), to: day(10) })
    const rb = await mkReservation({ bedId: w.bedIds[1], staffId: b.staffId, from: day(0), to: day(10) })
    await setBedState(w.bedIds[1], 'needs_cleaning')
    const arrivals = await get(arrivalsRoute, rec, { path: '/api/v1/stays/arrivals' })
    expect(arrivals.status).toBe(200)
    const rows = arrivals.body.data as { reservationId: string; view: string; block?: { owner: string; next: string } }[]
    expect(rows.find(x => x.reservationId === rb.reservationId)).toMatchObject({ view: 'Not ready', block: { owner: 'Housekeeping' } })
    expect(rows.find(x => x.reservationId === ra.reservationId)?.view).toBe('Expected')

    const bulk = await post(bulkRoute, rec, { reservationIds: [ra.reservationId, rb.reservationId] })
    expect(bulk.status).toBe(200)
    expect(bulk.body.data).toMatchObject({ checkedIn: 1, failed: 1 })
    expect((await post(bulkRoute, rec, { reservationIds: [] })).status).toBe(422)
  })
})

describe('requests through the API', () => {
  it('the resident asks for an extension and a transfer for their own stay; someone else\'s stay is not found', async () => {
    const w = await mkProperty({ beds: 3 })
    const r = await residentWithStay(w.bedIds[0])
    const stranger = await actor('Res')
    const ext = await post(extensionRoute, r.a, { newEnd: day(45) }, r.stayId)
    expect(ext.status).toBe(200)
    expect(ext.body.data).toMatchObject({ route: 'accommodation_admin', addedDays: 15 })
    const tr = await post(transferRoute, r.a, { destinationBedId: w.bedIds[1], reason: 'Closer to the lift' }, r.stayId)
    expect(tr.status).toBe(200)
    expect((await post(extensionRoute, stranger, { newEnd: day(45) }, r.stayId)).status).toBe(404)
    expect((await post(transferRoute, stranger, { reason: 'Closer to work' }, r.stayId)).status).toBe(404)
    const list = await get(transfersRoute, r.a, { path: '/api/v1/stays/transfers' })
    expect(list.body.data.map((t: { id: string }) => t.id)).toEqual([tr.body.data.id])
    expect((await get(transfersRoute, stranger, { path: '/api/v1/stays/transfers' })).body.data).toEqual([])
  })

  it('approve and execute over HTTP, with the two admins and Reception', async () => {
    const w = await world({ beds: 3 })
    const aaA = await actor('AA', { siteIds: [w.siteId] })
    const recA = await actor('Rec', { siteIds: [w.siteId] })
    const res = await residentWithStay(w.bedIds[0])
    const t = await post(transferRoute, res.a, { destinationBedId: w.bedIds[1], reason: 'Noise' }, res.stayId)
    const id = t.body.data.id as string
    expect((await post(executeRoute, recA, {}, id)).status).toBe(409) // not approved yet
    expect((await post(approveRoute, recA, {}, id)).status).toBe(403)  // Reception cannot approve
    expect((await post(approveRoute, aaA, {}, id)).status).toBe(200)
    expect((await post(executeRoute, recA, {}, id)).status).toBe(200)
    expect((await stayRow(res.stayId)).bed_id).toBe(w.bedIds[1])
  })
})

describe('the approvals inbox merges transfers and extensions (APPROVALS.md)', () => {
  it('the Accommodation Admin of the site sees them with the SLA clock; the person who raised one is told why they cannot decide it; other sites see nothing', async () => {
    const w = await world({ beds: 3 })
    const elsewhere = await world({ beds: 1 })
    const [res] = await residents(1)
    const s = await mkStay({ bedId: w.bedIds[0], staffId: res.staffId, from: day(-5), to: day(30) })
    const t = await requestTransfer(w.aa.rc, { stayId: s.stayId, destinationBedId: w.bedIds[1], reason: 'x', neededBy: null, linkedExtensionId: null })
    const e = await requestExtension(res.rc, { stayId: s.stayId, newEnd: day(40), reason: null })
    if (!t.ok || !e.ok) throw new Error('setup')
    const now = newClock().now()
    const mine = await listInbox(getDb(), w.aa.rc.actor, now)
    const tr = mine.find(i => i.ref === t.data.id)
    expect(tr).toMatchObject({ kind: 'transfer', mine: false })
    expect(tr?.why).toMatch(/separation of duties/i)
    expect(mine.find(i => i.ref === e.data.id)).toMatchObject({ kind: 'extension', mine: true })

    const aa2 = await person('AA', { siteIds: [w.siteId] })
    expect((await listInbox(getDb(), aa2.rc.actor, now)).find(i => i.ref === t.data.id)).toMatchObject({ mine: true })
    expect((await listInbox(getDb(), elsewhere.aa.rc.actor, now)).filter(i => [t.data.id, e.data.id].includes(i.ref))).toEqual([])
    // a request is waiting, not decided
    expect((await admin().query(`SELECT status FROM transfer_request WHERE id = $1`, [t.data.id])).rows[0].status).toBe('requested')
  })
})
