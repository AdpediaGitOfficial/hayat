import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { admin, closeAll, useClock } from '../harness'
import { actor, mkBed, mkBuilding, mkProperty, mkRoom, mkSite, occupy, reserve, send } from './helpers'
import { GET as listSites } from '../../../app/api/v1/property/sites/route'
import { GET as siteTree } from '../../../app/api/v1/property/sites/[id]/route'
import { GET as getBuilding } from '../../../app/api/v1/property/buildings/[id]/route'
import { GET as getRoom } from '../../../app/api/v1/property/rooms/[id]/route'
import { GET as getBed } from '../../../app/api/v1/property/beds/[id]/route'
import type { Role } from '@/domain/enums'

afterAll(closeAll)
beforeEach(() => { useClock() })

const tree = (a: Awaited<ReturnType<typeof actor>> | undefined, id: string, qs = '') => send(siteTree, a, { id, path: `/api/v1/property/sites/${id}${qs}` })
const idsOf = (body: { data: { id: string }[] }) => body.data.map(s => s.id)

describe('AT-002 scope for inventory', () => {
  it('SA sees every site; AA, Rec, MC, Mgr and Aud see only their own sites', async () => {
    const mine = await mkProperty(), theirs = await mkProperty()
    const sa = await actor('SA')
    expect(idsOf((await send(listSites, sa)).body)).toEqual(expect.arrayContaining([mine.siteId, theirs.siteId]))
    for (const role of ['AA', 'Rec', 'MC', 'Mgr', 'Aud'] as const) {
      const a = await actor(role, { siteIds: [mine.siteId] })
      const r = await send(listSites, a)
      expect(r.status, role).toBe(200)
      expect(idsOf(r.body), role).toEqual([mine.siteId])
      expect(r.body.data[0].beds.total, role).toBe(2)
    }
  })

  it('Security sees that a site exists (gate view) but not what is in it', async () => {
    const p = await mkProperty()
    const sec = await actor('Sec', { siteIds: [p.siteId] })
    const r = await send(listSites, sec)
    expect(r.status).toBe(200)
    expect(r.body.data).toHaveLength(1)
    expect(r.body.data[0].beds).toBeUndefined()
    expect((await tree(sec, p.siteId)).status).toBe(403)
    expect((await send(getBed, sec, { id: p.bedIds[0] })).status).toBe(403)
  })

  it('a resident has no inventory: the site list is 403, and every specific id is 404', async () => {
    const p = await mkProperty()
    const res = await actor('Res')
    expect((await send(listSites, res)).status).toBe(403)
    for (const [h, id] of [[siteTree, p.siteId], [getBuilding, p.buildingId!], [getRoom, p.roomId], [getBed, p.bedIds[0]]] as const) {
      const r = await send(h, res, { id })
      expect(r.status).toBe(404)
      expect(r.body.reason).toBe('Not found')
    }
  })

  it('a Technician or Contractor (job scope) does not get inventory either: 404', async () => {
    const p = await mkProperty()
    for (const role of ['Tech', 'Vend'] as Role[]) {
      const a = await actor(role, { siteIds: [p.siteId] })
      expect((await send(getBed, a, { id: p.bedIds[0] })).status, role).toBe(404)
      expect((await tree(a, p.siteId)).status, role).toBe(404)
    }
  })

  it('AT-002 a site, building, room or bed id from another site is 404 and looks exactly like an id that does not exist', async () => {
    const mine = await mkProperty(), theirs = await mkProperty()
    await occupy(theirs.bedIds[0])
    for (const role of ['AA', 'Rec', 'MC', 'Mgr', 'Aud'] as const) {
      const a = await actor(role, { siteIds: [mine.siteId] })
      for (const [h, real] of [[siteTree, theirs.siteId], [getBuilding, theirs.buildingId!], [getRoom, theirs.roomId], [getBed, theirs.bedIds[0]]] as const) {
        const foreign = await send(h, a, { id: real })
        const missing = await send(h, a, { id: randomUUID() })
        expect(foreign.status, `${role} ${real}`).toBe(404)
        expect(missing.status).toBe(404)
        const { requestId: _a, ...f } = foreign.body
        const { requestId: _b, ...m } = missing.body
        expect(f).toEqual(m)
      }
    }
  })

  it('malformed ids are 404, never a database error', async () => {
    const sa = await actor('SA')
    for (const h of [siteTree, getBuilding, getRoom, getBed]) expect((await send(h, sa, { id: "x'; drop table bed;--" })).status).toBe(404)
  })

  it('an actor with two sites sees both; one with a site in scope but asking for the other gets 404', async () => {
    const a1 = await mkProperty(), a2 = await mkProperty(), a3 = await mkProperty()
    const aa = await actor('AA', { siteIds: [a1.siteId, a2.siteId] })
    expect(idsOf((await send(listSites, aa)).body).sort()).toEqual([a1.siteId, a2.siteId].sort())
    expect((await tree(aa, a1.siteId)).status).toBe(200)
    expect((await tree(aa, a2.siteId)).status).toBe(200)
    expect((await tree(aa, a3.siteId)).status).toBe(404)
  })
})

describe('the site tree', () => {
  it('lists building -> room -> bed with counts, physical state, and dated claims alongside the state (D-17)', async () => {
    const siteId = await mkSite()
    const b = await mkBuilding(siteId, 'Block A')
    const r1 = await mkRoom(siteId, { buildingId: b, name: '101' })
    const direct = await mkRoom(siteId, { name: 'Garden room' })
    const free = await mkBed(r1, { code: 'A-1' })
    const occ = await mkBed(r1, { code: 'A-2' })
    const blocked = await mkBed(r1, { code: 'A-10', state: 'blocked' })
    await mkBed(direct, { code: 'G-1' })
    await occupy(occ)
    const soon = await reserve(free, '2026-10-20', '2026-10-30') // Available today, reserved from next week
    const aa = await actor('AA', { siteIds: [siteId] })
    const r = await tree(aa, siteId)
    expect(r.status).toBe(200)
    const t = r.body.data
    expect(t.counts).toMatchObject({ total: 4, available: 2, occupied: 1, blocked: 1 })
    expect(t.today).toBe('2026-10-14')
    expect(t.buildings).toHaveLength(1)
    expect(t.buildings[0]).toMatchObject({ name: 'Block A', counts: { total: 3 } })
    expect(t.directRooms.map((x: { name: string }) => x.name)).toEqual(['Garden room'])
    const beds = t.buildings[0].rooms[0].beds as { id: string; code: string; state: string; nextClaim: unknown; upcomingCount: number }[]
    expect(beds.map(x => x.code)).toEqual(['A-1', 'A-2', 'A-10']) // natural order
    const a1 = beds.find(x => x.id === free)!
    expect(a1.state).toBe('available')
    expect(a1.upcomingCount).toBe(1)
    expect(a1.nextClaim).toEqual({ claimId: soon.claimId, kind: 'reservation', from: '2026-10-20', to: '2026-10-30' })
    expect(beds.find(x => x.id === blocked)!.state).toBe('blocked')
  })

  it('filters by physical state, by "has a reservation", and by search text; counts stay for the whole site', async () => {
    const p = await mkProperty({ beds: 0 })
    const a = await mkBed(p.roomId, { code: 'N-1' })
    const b = await mkBed(p.roomId, { code: 'N-2', state: 'blocked' })
    await mkBed(p.roomId, { code: 'Z-9' })
    await reserve(a, '2026-11-01', '2026-11-20')
    await mkRoom(p.siteId, { buildingId: p.buildingId, name: 'Empty room' })
    const rec = await actor('Rec', { siteIds: [p.siteId] })
    const state = (await tree(rec, p.siteId, '?state=blocked')).body.data
    expect(state.buildings[0].rooms[0].beds.map((x: { id: string }) => x.id)).toEqual([b])
    expect(state.counts.total).toBe(3)
    expect(state.buildings[0].rooms).toHaveLength(1) // rooms without a match are hidden while filtering
    const reserved = (await tree(rec, p.siteId, '?reserved=1')).body.data
    expect(reserved.buildings[0].rooms[0].beds.map((x: { id: string }) => x.id)).toEqual([a])
    const q = (await tree(rec, p.siteId, '?q=z-9')).body.data
    expect(q.buildings[0].rooms[0].beds.map((x: { code: string }) => x.code)).toEqual(['Z-9'])
    const noMatch = (await tree(rec, p.siteId, '?q=nothing-like-this')).body.data
    expect(noMatch.buildings).toEqual([])
    const all = (await tree(rec, p.siteId)).body.data
    expect(all.buildings[0].rooms).toHaveLength(2) // the empty room shows when not filtering
  })

  it('search text is matched literally: % and _ are not wildcards, and quotes are harmless', async () => {
    const p = await mkProperty({ beds: 0 })
    await mkBed(p.roomId, { code: 'ABC-1' })
    const sa = await actor('SA')
    for (const q of ['%', '_', "'", '\\', 'A%1']) {
      const r = await tree(sa, p.siteId, `?q=${encodeURIComponent(q)}`)
      expect(r.status, q).toBe(200)
      expect(r.body.data.buildings, q).toEqual([])
    }
  })

  it('archived structures are hidden unless asked for', async () => {
    const p = await mkProperty({ beds: 2 })
    await admin().query(`UPDATE bed SET state = 'archived', archived_at = now() WHERE id = $1`, [p.bedIds[0]])
    const aa = await actor('AA', { siteIds: [p.siteId] })
    const hidden = (await tree(aa, p.siteId)).body.data
    expect(hidden.buildings[0].rooms[0].beds).toHaveLength(1)
    expect(hidden.counts.total).toBe(1)
    const shown = (await tree(aa, p.siteId, '?archived=1')).body.data
    expect(shown.buildings[0].rooms[0].beds).toHaveLength(2)
    const onlyArchived = (await tree(aa, p.siteId, '?state=archived')).body.data
    expect(onlyArchived.buildings[0].rooms[0].beds.map((x: { id: string }) => x.id)).toEqual([p.bedIds[0]])
  })

  it('room and building details carry their beds and roll-up counts', async () => {
    const p = await mkProperty({ beds: 3 })
    await occupy(p.bedIds[0])
    const mgr = await actor('Mgr', { siteIds: [p.siteId] })
    const room = await send(getRoom, mgr, { id: p.roomId })
    expect(room.status).toBe(200)
    expect(room.body.data).toMatchObject({ counts: { total: 3, occupied: 1, available: 2 }, archived: false })
    expect(room.body.data.beds).toHaveLength(3)
    const bld = await send(getBuilding, mgr, { id: p.buildingId! })
    expect(bld.body.data).toMatchObject({ counts: { total: 3 }, rooms: [{ id: p.roomId }] })
  })

  it('claim holders are staff data: AA sees who a claim is for, Reception does not', async () => {
    const p = await mkProperty({ beds: 1 })
    const held = await occupy(p.bedIds[0])
    const aa = await actor('AA', { siteIds: [p.siteId] })
    const rec = await actor('Rec', { siteIds: [p.siteId] })
    const a = (await send(getBed, aa, { id: p.bedIds[0] })).body.data
    expect(a.claims[0].holder).toMatchObject({ staffId: held.staffId })
    const r = (await send(getBed, rec, { id: p.bedIds[0] })).body.data
    expect('holder' in r.claims[0]).toBe(false)
  })
})
