import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { admin, closeAll, uniq, useClock } from '../harness'
import { actor, audits, auditCount, mkBuilding, mkProperty, mkRoom, mkSite, send } from './helpers'
import { GET as listSites, POST as createSite } from '../../../app/api/v1/property/sites/route'
import { PATCH as patchSite } from '../../../app/api/v1/property/sites/[id]/route'
import { POST as createBuilding } from '../../../app/api/v1/property/buildings/route'
import { PATCH as patchBuilding } from '../../../app/api/v1/property/buildings/[id]/route'
import { POST as createRoom } from '../../../app/api/v1/property/rooms/route'
import { PATCH as patchRoom } from '../../../app/api/v1/property/rooms/[id]/route'
import { POST as createBed } from '../../../app/api/v1/property/beds/route'
import { occupy, reserve } from './helpers'

afterAll(closeAll)
beforeEach(() => { useClock() })

const dbRow = async (sql: string, args: unknown[]) => (await admin().query(sql, args)).rows

describe('sites', () => {
  it('a Super Admin creates a site; the audit row is written in the same transaction', async () => {
    const sa = await actor('SA')
    const code = uniq('NEW')
    const r = await send(createSite, sa, { body: { code, name: '  Garden Villas ', kind: 'villa', timeZone: 'Asia/Dubai' } })
    expect(r.status).toBe(200)
    expect(r.body.data).toMatchObject({ code, name: 'Garden Villas' })
    const [row] = await dbRow(`SELECT kind, time_zone, archived_at FROM site WHERE id = $1`, [r.body.data.id])
    expect(row).toMatchObject({ kind: 'villa', time_zone: 'Asia/Dubai', archived_at: null })
    const a = await audits(r.body.data.id)
    expect(a).toHaveLength(1)
    expect(a[0]).toMatchObject({ action: 'property.site.created', actor_role: 'SA', site_id: r.body.data.id })
    expect(a[0].after).toMatchObject({ code, name: 'Garden Villas', timeZone: 'Asia/Dubai' })
  })

  it('an Accommodation Admin cannot create a site: 403 before anything is read', async () => {
    const siteId = await mkSite()
    const aa = await actor('AA', { siteIds: [siteId] })
    const r = await send(createSite, aa, { body: { code: uniq('X'), name: 'Nope' } })
    expect(r.status).toBe(403)
    expect(r.body.owner).toBeTruthy()
    expect(r.body.next).toBeTruthy()
  })

  it('refuses a duplicate site code, ignoring case and spaces, with a field message and no audit row', async () => {
    const sa = await actor('SA')
    const code = uniq('DUP')
    const first = await send(createSite, sa, { body: { code, name: 'First' } })
    expect(first.status).toBe(200)
    const before = (await dbRow(`SELECT count(*)::int AS n FROM audit_event WHERE action = 'property.site.created' AND after->>'code' ILIKE $1`, [code]))[0].n
    const r = await send(createSite, sa, { body: { code: ` ${code.toLowerCase()} `, name: 'Second' } })
    expect(r.status).toBe(409)
    expect(r.body.fields.code).toBeTruthy()
    expect(r.body.owner).toBeTruthy()
    expect(r.body.next).toBeTruthy()
    expect((await dbRow(`SELECT count(*)::int AS n FROM audit_event WHERE action = 'property.site.created' AND after->>'code' ILIKE $1`, [code]))[0].n).toBe(before)
  })

  it('validates input: blank name, bad code characters, unknown time zone', async () => {
    const sa = await actor('SA')
    const r = await send(createSite, sa, { body: { code: '<b>', name: '   ', timeZone: 'Mars/Olympus' } })
    expect(r.status).toBe(422)
    expect(Object.keys(r.body.fields).sort()).toEqual(['code', 'name', 'timeZone'])
  })

  it('updates name, kind and time zone; the code is not editable; nothing-to-change is refused', async () => {
    const sa = await actor('SA')
    const siteId = await mkSite({ name: 'Old' })
    const r = await send(patchSite, sa, { method: 'PATCH', id: siteId, body: { name: 'New name', timeZone: 'Asia/Kolkata', code: 'IGNORED' } })
    expect(r.status).toBe(200)
    const [row] = await dbRow(`SELECT name, time_zone, code FROM site WHERE id = $1`, [siteId])
    expect(row).toMatchObject({ name: 'New name', time_zone: 'Asia/Kolkata' })
    expect(row.code).not.toBe('IGNORED')
    const a = await audits(siteId)
    expect(a.map(x => x.action)).toEqual(['property.site.updated'])
    expect(a[0].before).toMatchObject({ name: 'Old' })
    expect(a[0].after).toMatchObject({ name: 'New name', timeZone: 'Asia/Kolkata' })
    const none = await send(patchSite, sa, { method: 'PATCH', id: siteId, body: {} })
    expect(none.status).toBe(422)
  })

  it('an AA may not edit a site (the matrix gives "manage" to the Super Admin only)', async () => {
    const siteId = await mkSite()
    const aa = await actor('AA', { siteIds: [siteId] })
    expect((await send(patchSite, aa, { method: 'PATCH', id: siteId, body: { name: 'Mine now' } })).status).toBe(403)
  })

  it('lists only the sites in scope, with bed counts for roles that may see beds', async () => {
    const a = await mkProperty({ beds: 3 })
    const b = await mkProperty({ beds: 1 })
    await occupy(a.bedIds[0])
    const aa = await actor('AA', { siteIds: [a.siteId] })
    const r = await send(listSites, aa)
    expect(r.status).toBe(200)
    const ids = r.body.data.map((s: { id: string }) => s.id)
    expect(ids).toContain(a.siteId)
    expect(ids).not.toContain(b.siteId)
    const mine = r.body.data.find((s: { id: string }) => s.id === a.siteId)
    expect(mine.beds).toMatchObject({ total: 3, occupied: 1, available: 2 })
    expect(mine).toMatchObject({ rooms: 1, buildings: 1 })
  })
})

describe('buildings', () => {
  it('a Super Admin creates a building', async () => {
    const sa = await actor('SA')
    const siteId = await mkSite()
    const r = await send(createBuilding, sa, { body: { siteId, code: 'A', name: 'Block A' } })
    expect(r.status).toBe(200)
    const a = await audits(r.body.data.id)
    expect(a).toHaveLength(1)
    expect(a[0]).toMatchObject({ action: 'property.building.created', site_id: siteId })
  })

  it('an AA without Building Creation is refused (403); with the capability they can build inside their own site only', async () => {
    const mine = await mkSite()
    const other = await mkSite()
    const plain = await actor('AA', { siteIds: [mine] })
    expect((await send(createBuilding, plain, { body: { siteId: mine, code: 'A', name: 'Block A' } })).status).toBe(403)

    const capable = await actor('AA', { siteIds: [mine], caps: ['BuildingCreation'] })
    const ok = await send(createBuilding, capable, { body: { siteId: mine, code: 'A', name: 'Block A' } })
    expect(ok.status).toBe(200)
    // The capability adds the action, never the scope (D-22): another site looks like it does not exist.
    const elsewhere = await send(createBuilding, capable, { body: { siteId: other, code: 'A', name: 'Block A' } })
    expect(elsewhere.status).toBe(404)
    expect(await dbRow(`SELECT 1 FROM building WHERE site_id = $1`, [other])).toHaveLength(0)
  })

  it('a missing site is 404 for a Super Admin as well', async () => {
    const sa = await actor('SA')
    const r = await send(createBuilding, sa, { body: { siteId: crypto.randomUUID(), code: 'A', name: 'Block A' } })
    expect(r.status).toBe(404)
  })

  it('building codes are unique within a site (case-insensitive) but may repeat across sites', async () => {
    const sa = await actor('SA')
    const s1 = await mkSite(), s2 = await mkSite()
    expect((await send(createBuilding, sa, { body: { siteId: s1, code: 'A', name: 'Block A' } })).status).toBe(200)
    const dup = await send(createBuilding, sa, { body: { siteId: s1, code: 'a', name: 'Block A again' } })
    expect(dup.status).toBe(409)
    expect(dup.body.fields.code).toBeTruthy()
    expect((await send(createBuilding, sa, { body: { siteId: s2, code: 'A', name: 'Block A' } })).status).toBe(200)
  })

  it('two admins creating the same building code at once: exactly one wins, the other gets a clean conflict', async () => {
    const siteId = await mkSite()
    const sa1 = await actor('SA'), sa2 = await actor('SA')
    const body = { siteId, code: 'RACE', name: 'Race block' }
    const results = await Promise.all([send(createBuilding, sa1, { body }), send(createBuilding, sa2, { body }), send(createBuilding, sa1, { body }), send(createBuilding, sa2, { body })])
    const statuses = results.map(r => r.status).sort()
    expect(statuses).toEqual([200, 409, 409, 409])
    expect(await dbRow(`SELECT 1 FROM building WHERE site_id = $1`, [siteId])).toHaveLength(1)
    // Only the winner left an audit row.
    expect(await auditCount(siteId)).toBe(1)
    for (const r of results.filter(r => r.status === 409)) expect(r.body.next).toBeTruthy()
  })

  it('renames a building and changes its code (Super Admin only); a clashing code is a conflict', async () => {
    const sa = await actor('SA')
    const siteId = await mkSite()
    const b1 = await mkBuilding(siteId, 'One'), b2 = await mkBuilding(siteId, 'Two')
    const ok = await send(patchBuilding, sa, { method: 'PATCH', id: b1, body: { name: 'Block One', code: 'ONE' } })
    expect(ok.status).toBe(200)
    expect((await audits(b1)).map(a => a.action)).toEqual(['property.building.updated'])
    const clash = await send(patchBuilding, sa, { method: 'PATCH', id: b2, body: { code: 'one' } })
    expect(clash.status).toBe(409)
    expect((await dbRow(`SELECT code FROM building WHERE id = $1`, [b2]))[0].code).not.toBe('one')
    const aa = await actor('AA', { siteIds: [siteId], caps: ['BuildingCreation'] })
    expect((await send(patchBuilding, aa, { method: 'PATCH', id: b2, body: { name: 'x' } })).status).toBe(403)
  })
})

describe('rooms and beds', () => {
  it('an AA adds a room with beds inside a building; floor and unit are optional', async () => {
    const siteId = await mkSite()
    const buildingId = await mkBuilding(siteId)
    const aa = await actor('AA', { siteIds: [siteId] })
    const r = await send(createRoom, aa, { body: { siteId, buildingId, floor: '3', unit: '3B', name: '301', genderPolicy: 'female', bedCodes: ['301-A', '301-B'] } })
    expect(r.status).toBe(200)
    expect(r.body.data.beds.map((b: { code: string }) => b.code)).toEqual(['301-A', '301-B'])
    const [room] = await dbRow(`SELECT building_id, floor, unit, gender_policy FROM room WHERE id = $1`, [r.body.data.id])
    expect(room).toMatchObject({ building_id: buildingId, floor: '3', unit: '3B', gender_policy: 'female' })
    const beds = await dbRow(`SELECT state, site_id FROM bed WHERE room_id = $1`, [r.body.data.id])
    expect(beds).toHaveLength(2)
    expect(beds.every(b => b.state === 'available' && b.site_id === siteId)).toBe(true)
    expect((await audits(r.body.data.id)).map(a => a.action)).toEqual(['property.room.created'])
    for (const b of r.body.data.beds) expect((await audits(b.id)).map(a => a.action)).toEqual(['property.bed.created'])
  })

  it('a villa is Site -> Room -> Bed: no building, floor or unit needed', async () => {
    const siteId = await mkSite()
    const aa = await actor('AA', { siteIds: [siteId] })
    const r = await send(createRoom, aa, { body: { siteId, name: 'Master bedroom' } })
    expect(r.status).toBe(200)
    expect((await dbRow(`SELECT building_id, floor, unit, gender_policy FROM room WHERE id = $1`, [r.body.data.id]))[0]).toEqual({ building_id: null, floor: null, unit: null, gender_policy: 'any' })
    const bed = await send(createBed, aa, { body: { roomId: r.body.data.id, code: uniq('V') } })
    expect(bed.status).toBe(200)
  })

  it('refuses rooms in a building of another site without saying whether that building exists', async () => {
    const mine = await mkSite(), other = await mkSite()
    const foreign = await mkBuilding(other)
    const aa = await actor('AA', { siteIds: [mine] })
    const r = await send(createRoom, aa, { body: { siteId: mine, buildingId: foreign, name: '101' } })
    expect(r.status).toBe(422)
    expect(r.body.fields.buildingId).toBeTruthy()
    const missing = await send(createRoom, aa, { body: { siteId: mine, buildingId: crypto.randomUUID(), name: '101' } })
    expect(missing.status).toBe(422)
    expect(missing.body.fields).toEqual(r.body.fields)
  })

  it('AT-002 an AA cannot create rooms or beds in a site that is not theirs: 404, nothing written', async () => {
    const mine = await mkSite()
    const p = await mkProperty()
    const aa = await actor('AA', { siteIds: [mine] })
    const room = await send(createRoom, aa, { body: { siteId: p.siteId, name: 'Sneaky' } })
    expect(room.status).toBe(404)
    const bed = await send(createBed, aa, { body: { roomId: p.roomId, code: uniq('X') } })
    expect(bed.status).toBe(404)
    expect(await dbRow(`SELECT 1 FROM room WHERE site_id = $1 AND name = 'Sneaky'`, [p.siteId])).toHaveLength(0)
    expect(await auditCount(p.siteId)).toBe(0)
  })

  it('Reception, Maintenance Coordinator, Manager and Auditor cannot create rooms or beds (403)', async () => {
    const p = await mkProperty()
    for (const role of ['Rec', 'MC', 'Mgr', 'Aud', 'Sec'] as const) {
      const a = await actor(role, { siteIds: [p.siteId] })
      expect((await send(createRoom, a, { body: { siteId: p.siteId, name: 'No' } })).status, role).toBe(403)
      expect((await send(createBed, a, { body: { roomId: p.roomId, code: uniq('N') } })).status, role).toBe(403)
    }
    const res = await actor('Res')
    expect((await send(createBed, res, { body: { roomId: p.roomId, code: uniq('N') } })).status).toBe(403)
  })

  it('room names are unique per building, floor and unit; the same name may exist elsewhere', async () => {
    const siteId = await mkSite()
    const b1 = await mkBuilding(siteId), b2 = await mkBuilding(siteId)
    const aa = await actor('AA', { siteIds: [siteId] })
    expect((await send(createRoom, aa, { body: { siteId, buildingId: b1, floor: '1', name: '101' } })).status).toBe(200)
    const dup = await send(createRoom, aa, { body: { siteId, buildingId: b1, floor: '1', name: ' 101 ' } })
    expect(dup.status).toBe(409)
    expect(dup.body.fields.name).toBeTruthy()
    expect((await send(createRoom, aa, { body: { siteId, buildingId: b2, floor: '1', name: '101' } })).status).toBe(200)
    expect((await send(createRoom, aa, { body: { siteId, buildingId: b1, floor: '2', name: '101' } })).status).toBe(200)
  })

  it('bed codes are unique within a site; a clash rolls back the whole room', async () => {
    const siteId = await mkSite()
    const aa = await actor('AA', { siteIds: [siteId] })
    const first = await send(createRoom, aa, { body: { siteId, name: 'R1', bedCodes: ['K-1'] } })
    expect(first.status).toBe(200)
    const before = await auditCount(siteId)
    const clash = await send(createRoom, aa, { body: { siteId, name: 'R2', bedCodes: ['K-2', 'k-1'] } })
    expect(clash.status).toBe(409)
    expect(clash.body.fields.bedCodes).toBeTruthy()
    expect(await dbRow(`SELECT 1 FROM room WHERE site_id = $1 AND name = 'R2'`, [siteId])).toHaveLength(0)
    expect(await dbRow(`SELECT 1 FROM bed WHERE site_id = $1 AND lower(code) = 'k-2'`, [siteId])).toHaveLength(0)
    expect(await auditCount(siteId)).toBe(before)
    const single = await send(createBed, aa, { body: { roomId: first.body.data.id, code: 'K-1' } })
    expect(single.status).toBe(409)
  })

  it('rejects the same bed code twice in one request', async () => {
    const siteId = await mkSite()
    const aa = await actor('AA', { siteIds: [siteId] })
    const r = await send(createRoom, aa, { body: { siteId, name: 'R', bedCodes: ['X-1', 'x-1'] } })
    expect(r.status).toBe(422)
    expect(r.body.fields.bedCodes).toBeTruthy()
  })

  it('two admins adding the same bed code at once: exactly one wins', async () => {
    const p = await mkProperty({ beds: 0 })
    const a1 = await actor('AA', { siteIds: [p.siteId] }), a2 = await actor('AA', { siteIds: [p.siteId] })
    const body = { roomId: p.roomId, code: 'RACE-1' }
    const rs = await Promise.all([send(createBed, a1, { body }), send(createBed, a2, { body }), send(createBed, a1, { body })])
    expect(rs.map(r => r.status).sort()).toEqual([200, 409, 409])
    expect(await dbRow(`SELECT 1 FROM bed WHERE room_id = $1`, [p.roomId])).toHaveLength(1)
  })

  it('cannot add beds to an archived room or rooms to an archived building', async () => {
    const siteId = await mkSite()
    const buildingId = await mkBuilding(siteId)
    const roomId = await mkRoom(siteId, { buildingId })
    await admin().query(`UPDATE room SET archived_at = now() WHERE id = $1`, [roomId])
    await admin().query(`UPDATE building SET archived_at = now() WHERE id = $1`, [buildingId])
    const aa = await actor('AA', { siteIds: [siteId] })
    const bed = await send(createBed, aa, { body: { roomId, code: uniq('Z') } })
    expect(bed.status).toBe(409)
    expect(bed.body.reason).toMatch(/archived/)
    const room = await send(createRoom, aa, { body: { siteId, buildingId, name: 'New' } })
    expect(room.status).toBe(409)
    expect(room.body.reason).toMatch(/archived/)
  })

  it('updates a room (name, floor, unit); null clears; left-out fields stay', async () => {
    const siteId = await mkSite()
    const aa = await actor('AA', { siteIds: [siteId] })
    const created = await send(createRoom, aa, { body: { siteId, floor: '2', unit: '2A', name: 'Old' } })
    const id = created.body.data.id
    const r = await send(patchRoom, aa, { method: 'PATCH', id, body: { name: 'New', unit: null } })
    expect(r.status).toBe(200)
    expect((await dbRow(`SELECT name, floor, unit FROM room WHERE id = $1`, [id]))[0]).toEqual({ name: 'New', floor: '2', unit: null })
    const a = await audits(id)
    expect(a.map(x => x.action)).toEqual(['property.room.created', 'property.room.updated'])
    expect(a[1].before).toMatchObject({ name: 'Old', unit: '2A' })
    expect(a[1].after).toMatchObject({ name: 'New', unit: null })
  })

  it('the gender policy of a room cannot change while it is occupied or booked, and says who must act', async () => {
    const p = await mkProperty({ beds: 2 })
    const aa = await actor('AA', { siteIds: [p.siteId] })
    await occupy(p.bedIds[0])
    await reserve(p.bedIds[1], '2026-12-01', '2026-12-31')
    const r = await send(patchRoom, aa, { method: 'PATCH', id: p.roomId, body: { genderPolicy: 'female' } })
    expect(r.status).toBe(409)
    expect(r.body.owner).toBeTruthy()
    expect(r.body.next).toBeTruthy()
    expect(r.body.detail.blockers.map((b: { kind: string }) => b.kind).sort()).toEqual(['live_claim', 'occupied_bed'])
    expect((await dbRow(`SELECT gender_policy FROM room WHERE id = $1`, [p.roomId]))[0].gender_policy).toBe('any')
    // Other edits are fine while people live there.
    expect((await send(patchRoom, aa, { method: 'PATCH', id: p.roomId, body: { floor: '4' } })).status).toBe(200)
  })

  it('the gender policy of an empty room can change', async () => {
    const p = await mkProperty({ beds: 2 })
    const aa = await actor('AA', { siteIds: [p.siteId] })
    expect((await send(patchRoom, aa, { method: 'PATCH', id: p.roomId, body: { genderPolicy: 'male' } })).status).toBe(200)
  })

  it('an out-of-scope room is 404 for update', async () => {
    const p = await mkProperty()
    const other = await mkSite()
    const aa = await actor('AA', { siteIds: [other] })
    expect((await send(patchRoom, aa, { method: 'PATCH', id: p.roomId, body: { name: 'Mine' } })).status).toBe(404)
    expect((await send(patchRoom, aa, { method: 'PATCH', id: 'not-a-uuid', body: { name: 'Mine' } })).status).toBe(404)
  })

  it('a new bed starts Available', async () => {
    const p = await mkProperty({ beds: 0 })
    const aa = await actor('AA', { siteIds: [p.siteId] })
    const r = await send(createBed, aa, { body: { roomId: p.roomId, code: uniq('A') } })
    expect((await dbRow(`SELECT state FROM bed WHERE id = $1`, [r.body.data.id]))[0].state).toBe('available')
  })
})
