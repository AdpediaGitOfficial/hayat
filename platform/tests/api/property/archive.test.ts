import { Client } from 'pg'
import { afterAll, beforeEach, describe, expect, it, inject } from 'vitest'
import { admin, closeAll, useClock } from '../harness'
import { actor, audits, auditCount, bedRow, mkBed, mkBuilding, mkProperty, mkRoom, mkSite, occupy, reserve, send } from './helpers'
import { POST as archiveBed, GET as checkBed } from '../../../app/api/v1/property/beds/[id]/archive/route'
import { POST as archiveRoom, GET as checkRoom } from '../../../app/api/v1/property/rooms/[id]/archive/route'
import { POST as archiveBuilding, GET as checkBuilding } from '../../../app/api/v1/property/buildings/[id]/archive/route'
import { POST as block } from '../../../app/api/v1/property/beds/[id]/block/route'
import { POST as createBed } from '../../../app/api/v1/property/beds/route'
import { POST as createRoom } from '../../../app/api/v1/property/rooms/route'
import { archiveStructure } from '@/server/commands/property/archive'
import { buildActor } from '@/server/auth/actor'
import { getClock } from '@/server/runtime'
import { randomUUID } from 'node:crypto'

afterAll(closeAll)
beforeEach(() => { useClock() })

const REASON = { reason: 'Space returned to the owner' }
const row = async (sql: string, args: unknown[]) => (await admin().query(sql, args)).rows

describe('AT-029 archive dependencies', () => {
  it('AT-029 archiving an occupied room is blocked with the dependencies listed', async () => {
    const p = await mkProperty({ beds: 3 })
    await occupy(p.bedIds[0])
    await reserve(p.bedIds[1], '2026-11-01', '2026-11-30')
    const aa = await actor('AA', { siteIds: [p.siteId] })
    const r = await send(archiveRoom, aa, { id: p.roomId, body: REASON })
    expect(r.status).toBe(409)
    expect(r.body.code).toBe('conflict')
    expect(r.body.reason).toMatch(/can't be archived/)
    expect(r.body.reason).toMatch(/1 occupied bed/)
    expect(r.body.owner).toBeTruthy()
    expect(r.body.next).toBeTruthy()
    const blockers = r.body.detail.blockers as { kind: string; entityType: string; entityId: string; why: string; owner: string; next: string; label: string }[]
    // Each dependency says what it is, who owns it and what to do.
    for (const b of blockers) for (const k of ['kind', 'entityType', 'entityId', 'label', 'why', 'owner', 'next'] as const) expect(b[k], `${b.kind}.${k}`).toBeTruthy()
    const occupied = blockers.find(b => b.kind === 'occupied_bed')!
    expect(occupied.entityId).toBe(p.bedIds[0])
    expect(blockers.find(b => b.kind === 'live_claim')).toMatchObject({ entityId: p.bedIds[1], claim: { kind: 'reservation', from: '2026-11-01', to: '2026-11-30' } })
    // The third bed is free but still active in the room, so the room cannot be archived on its own either.
    expect(blockers.filter(b => b.kind === 'active_child').map(b => b.entityId).sort()).toEqual([...p.bedIds].sort())
    expect(r.body.detail.total).toBe(blockers.length)
    // Nothing changed, nothing was audited.
    expect((await row(`SELECT archived_at FROM room WHERE id = $1`, [p.roomId]))[0].archived_at).toBeNull()
    expect((await bedRow(p.bedIds[0])).state).toBe('occupied')
    expect(await auditCount(p.siteId)).toBe(0)
  })

  it('AT-029 archiving a building with an occupied room is blocked with the dependencies listed', async () => {
    const p = await mkProperty({ beds: 2 })
    await occupy(p.bedIds[1])
    const sa = await actor('SA')
    const r = await send(archiveBuilding, sa, { id: p.buildingId!, body: { ...REASON, cascade: true } })
    expect(r.status).toBe(409)
    // With cascade the active rooms and beds are not the problem; the resident is.
    expect(r.body.detail.blockers.map((b: { kind: string }) => b.kind)).toEqual(['occupied_bed'])
    expect(r.body.detail.blockers[0].entityId).toBe(p.bedIds[1])
    expect((await row(`SELECT archived_at FROM building WHERE id = $1`, [p.buildingId]))[0].archived_at).toBeNull()
    expect(await auditCount(p.siteId)).toBe(0)
    // Without cascade the active room is listed as well.
    const plain = await send(archiveBuilding, sa, { id: p.buildingId!, body: REASON })
    expect(plain.body.detail.blockers.map((b: { kind: string }) => b.kind).sort()).toEqual(['active_child', 'occupied_bed'])
  })

  it('beds that are being cleaned, inspected or repaired block an archive and name the owner', async () => {
    const p = await mkProperty({ beds: 0 })
    const states = ['needs_cleaning', 'inspection_required', 'under_maintenance']
    const ids = [] as string[]
    for (const s of states) ids.push(await mkBed(p.roomId, { state: s }))
    const aa = await actor('AA', { siteIds: [p.siteId] })
    const r = await send(archiveRoom, aa, { id: p.roomId, body: { ...REASON, cascade: true } })
    expect(r.status).toBe(409)
    const b = r.body.detail.blockers as { kind: string; entityId: string; owner: string }[]
    expect(b.every(x => x.kind === 'bed_not_ready')).toBe(true)
    expect(b.map(x => x.owner).sort()).toEqual(['Final Inspection holder', 'Housekeeping', 'Maintenance Coordinator'])
    expect(b.map(x => x.entityId).sort()).toEqual([...ids].sort())
  })

  it('a pending bed-offer hold blocks the archive too', async () => {
    const p = await mkProperty({ beds: 1 })
    await admin().query(`INSERT INTO bed_claim (bed_id, kind, period) VALUES ($1, 'offer_hold', '[2026-11-01,2026-12-01)')`, [p.bedIds[0]])
    const aa = await actor('AA', { siteIds: [p.siteId] })
    const r = await send(archiveBed, aa, { id: p.bedIds[0], body: REASON })
    expect(r.status).toBe(409)
    expect(r.body.detail.blockers[0]).toMatchObject({ kind: 'live_claim', claim: { kind: 'offer_hold' } })
  })

  it('a released claim (history) does not block', async () => {
    const p = await mkProperty({ beds: 1 })
    const c = await reserve(p.bedIds[0], '2026-11-01', '2026-11-30')
    await admin().query(`UPDATE bed_claim SET released_at = now(), release_reason = 'cancelled' WHERE id = $1`, [c.claimId])
    const aa = await actor('AA', { siteIds: [p.siteId] })
    expect((await send(archiveBed, aa, { id: p.bedIds[0], body: REASON })).status).toBe(200)
  })

  it('archive is the end of the line, never a delete: rows stay, archived_at is set, audit written, the bed leaves the active lists', async () => {
    const p = await mkProperty({ beds: 2 })
    const aa = await actor('AA', { siteIds: [p.siteId] })
    const r = await send(archiveBed, aa, { id: p.bedIds[0], body: REASON })
    expect(r.status).toBe(200)
    expect(r.body.data).toMatchObject({ id: p.bedIds[0], kind: 'bed', archived: { beds: 1 } })
    const [b] = await row(`SELECT state, archived_at FROM bed WHERE id = $1`, [p.bedIds[0]])
    expect(b.state).toBe('archived')
    expect(b.archived_at).not.toBeNull()
    const a = await audits(p.bedIds[0])
    expect(a).toHaveLength(1)
    expect(a[0]).toMatchObject({ action: 'property.bed.archived', reason: REASON.reason, actor_role: 'AA', site_id: p.siteId })
    expect(a[0].before.state).toBe('available')
    // Archiving twice is a clean conflict.
    const again = await send(archiveBed, aa, { id: p.bedIds[0], body: REASON })
    expect(again.status).toBe(409)
    expect(again.body.reason).toMatch(/already archived/)
    // Room is still blocked by the remaining bed until it goes too; then it archives.
    expect((await send(archiveRoom, aa, { id: p.roomId, body: REASON })).status).toBe(409)
    expect((await send(archiveBed, aa, { id: p.bedIds[1], body: REASON })).status).toBe(200)
    const room = await send(archiveRoom, aa, { id: p.roomId, body: REASON })
    expect(room.status).toBe(200)
    expect((await row(`SELECT archived_at FROM room WHERE id = $1`, [p.roomId]))[0].archived_at).not.toBeNull()
    const sa = await actor('SA')
    const bld = await send(archiveBuilding, sa, { id: p.buildingId!, body: REASON })
    expect(bld.status).toBe(200)
    expect((await row(`SELECT archived_at FROM building WHERE id = $1`, [p.buildingId]))[0].archived_at).not.toBeNull()
    // Still all there.
    expect(await row(`SELECT 1 FROM bed WHERE site_id = $1`, [p.siteId])).toHaveLength(2)
    expect(await row(`SELECT 1 FROM room WHERE id = $1`, [p.roomId])).toHaveLength(1)
    expect(await row(`SELECT 1 FROM building WHERE id = $1`, [p.buildingId])).toHaveLength(1)
  })

  it('a blocked bed can be archived and its open block is closed', async () => {
    const p = await mkProperty({ beds: 1 })
    const aa = await actor('AA', { siteIds: [p.siteId] })
    await send(block, aa, { id: p.bedIds[0], body: { reason: 'Mould' } })
    expect((await send(archiveBed, aa, { id: p.bedIds[0], body: REASON })).status).toBe(200)
    const blocks = await row(`SELECT released_at FROM bed_block WHERE bed_id = $1`, [p.bedIds[0]])
    expect(blocks).toHaveLength(1)
    expect(blocks[0].released_at).not.toBeNull()
  })

  it('cascade archives free rooms and beds together, one audit row per entity; the reason is required', async () => {
    const p = await mkProperty({ beds: 2 })
    const room2 = await mkRoom(p.siteId, { buildingId: p.buildingId })
    const bed3 = await mkBed(room2)
    const sa = await actor('SA')
    const noReason = await send(archiveBuilding, sa, { id: p.buildingId!, body: { cascade: true } })
    expect(noReason.status).toBe(422)
    const r = await send(archiveBuilding, sa, { id: p.buildingId!, body: { ...REASON, cascade: true } })
    expect(r.status).toBe(200)
    expect(r.body.data.archived).toEqual({ buildings: 1, rooms: 2, beds: 3 })
    expect(await row(`SELECT 1 FROM bed WHERE id = ANY($1) AND state = 'archived' AND archived_at IS NOT NULL`, [[...p.bedIds, bed3]])).toHaveLength(3)
    expect((await audits(p.buildingId!)).map(a => a.action)).toEqual(['property.building.archived'])
    expect((await audits(p.roomId)).map(a => a.action)).toEqual(['property.room.archived'])
    expect((await audits(bed3)).map(a => a.action)).toEqual(['property.bed.archived'])
  })

  it('previews the blockers read-only before anyone clicks: same list, nothing locked or changed', async () => {
    const p = await mkProperty({ beds: 2 })
    await occupy(p.bedIds[0])
    const aa = await actor('AA', { siteIds: [p.siteId] })
    const r = await send(checkRoom, aa, { id: p.roomId })
    expect(r.status).toBe(200)
    expect(r.body.data).toMatchObject({ kind: 'room', archivable: false, alreadyArchived: false })
    expect(r.body.data.blockers.map((b: { kind: string }) => b.kind)).toContain('occupied_bed')
    expect(r.body.data.summary).toMatch(/occupied bed/)
    const bed = await send(checkBed, aa, { id: p.bedIds[1] })
    expect(bed.body.data).toMatchObject({ archivable: true, blockers: [], total: 0 })
    const sa = await actor('SA')
    const cascade = await send(checkBuilding, sa, { id: p.buildingId!, path: undefined })
    expect(cascade.status).toBe(200)
    expect(await auditCount(p.siteId)).toBe(0)
  })

  it('who may archive: AA and SA archive beds and rooms; only SA archives buildings; others 403', async () => {
    const p = await mkProperty({ beds: 0 })
    const aa = await actor('AA', { siteIds: [p.siteId], caps: ['BuildingCreation'] })
    expect((await send(archiveBuilding, aa, { id: p.buildingId!, body: REASON })).status).toBe(403)
    for (const role of ['Rec', 'MC', 'Mgr', 'Aud', 'Sec', 'Res', 'Tech', 'Vend'] as const) {
      const a = await actor(role, { siteIds: [p.siteId] })
      expect((await send(archiveRoom, a, { id: p.roomId, body: REASON })).status, role).toBe(403)
      expect((await send(archiveBed, a, { id: randomUUID(), body: REASON })).status, role).toBe(403)
      expect((await send(checkRoom, a, { id: p.roomId })).status, role).toBe(403)
    }
    expect((await send(archiveRoom, aa, { id: p.roomId, body: REASON })).status).toBe(200)
  })

  it('AT-002 an AA from another site gets 404 (not 403, not the dependency list) for archive and preview', async () => {
    const p = await mkProperty({ beds: 1 })
    await occupy(p.bedIds[0])
    const other = await mkSite()
    const aa = await actor('AA', { siteIds: [other] })
    for (const [h, id] of [[archiveBed, p.bedIds[0]], [archiveRoom, p.roomId]] as const) {
      const r = await send(h, aa, { id, body: REASON })
      expect(r.status).toBe(404)
      expect(r.body.detail).toBeUndefined()
    }
    for (const [h, id] of [[checkBed, p.bedIds[0]], [checkRoom, p.roomId]] as const) expect((await send(h, aa, { id })).status).toBe(404)
    const missing = await send(checkRoom, aa, { id: randomUUID() })
    expect(missing.status).toBe(404)
    expect(missing.body).toMatchObject({ reason: 'Not found' })
  })
})

describe('archive vs a reservation created at the same moment', () => {
  it('claim first: the archive waits for the uncommitted reservation, then refuses it', async () => {
    const p = await mkProperty({ beds: 1 })
    const aa = await actor('AA', { siteIds: [p.siteId] })
    const c = new Client({ connectionString: inject('dbUrl') })
    await c.connect()
    try {
      await c.query('BEGIN')
      await c.query(`INSERT INTO bed_claim (bed_id, kind, period) VALUES ($1, 'reservation', '[2026-11-01,2026-11-10)')`, [p.bedIds[0]])
      let finished = false
      const pending = send(archiveBed, aa, { id: p.bedIds[0], body: REASON }).then(r => { finished = true; return r })
      // The archive must be stuck on the bed row the reservation holds, not racing past it.
      await new Promise(r => setTimeout(r, 400))
      expect(finished).toBe(false)
      await c.query('COMMIT')
      const r = await pending
      expect(r.status).toBe(409)
      expect(r.body.detail.blockers[0]).toMatchObject({ kind: 'live_claim', entityId: p.bedIds[0] })
      expect((await bedRow(p.bedIds[0])).state).toBe('available')
    } finally {
      await c.query('ROLLBACK').catch(() => {})
      await c.end()
    }
  })

  it('archive first: the reservation is refused by the database once the archive commits', async () => {
    const p = await mkProperty({ beds: 1 })
    const aa = await actor('AA', { siteIds: [p.siteId] })
    expect((await send(archiveBed, aa, { id: p.bedIds[0], body: REASON })).status).toBe(200)
    await expect(admin().query(`INSERT INTO bed_claim (bed_id, kind, period) VALUES ($1, 'reservation', '[2026-11-01,2026-11-10)')`, [p.bedIds[0]]))
      .rejects.toMatchObject({ code: 'GH001' })
  })

  it('archive holding the lock: a claim that arrives meanwhile waits and is then refused (no claim on an archived bed)', async () => {
    const p = await mkProperty({ beds: 1 })
    const c = new Client({ connectionString: inject('dbUrl') })
    await c.connect()
    try {
      await c.query('BEGIN')
      await c.query(`SELECT 1 FROM bed WHERE id = $1 FOR UPDATE`, [p.bedIds[0]])
      await c.query(`UPDATE bed SET state = 'archived', archived_at = now() WHERE id = $1`, [p.bedIds[0]])
      const late = admin().query(`INSERT INTO bed_claim (bed_id, kind, period) VALUES ($1, 'reservation', '[2026-11-01,2026-11-10)')`, [p.bedIds[0]]).then(() => 'inserted', e => (e as { code: string }).code)
      await new Promise(r => setTimeout(r, 300))
      await c.query('COMMIT')
      expect(await late).toBe('GH001')
    } finally {
      await c.query('ROLLBACK').catch(() => {})
      await c.end()
    }
    expect(await row(`SELECT 1 FROM bed_claim WHERE bed_id = $1`, [p.bedIds[0]])).toHaveLength(0)
  })

  it('many archive attempts and reservations at once: either the bed ends archived with no live claim, or it has a claim and is not archived', async () => {
    for (let round = 0; round < 5; round++) {
      const p = await mkProperty({ beds: 1 })
      const aa = await actor('AA', { siteIds: [p.siteId] })
      const claim = admin().query(`INSERT INTO bed_claim (bed_id, kind, period) VALUES ($1, 'reservation', '[2026-11-01,2026-11-10)')`, [p.bedIds[0]]).then(() => 'claimed', e => (e as { code: string }).code)
      const arch = send(archiveBed, aa, { id: p.bedIds[0], body: REASON })
      const [cl, ar] = await Promise.all([claim, arch])
      const state = (await bedRow(p.bedIds[0])).state
      const live = (await row(`SELECT count(*)::int AS n FROM bed_claim WHERE bed_id = $1 AND released_at IS NULL`, [p.bedIds[0]]))[0].n
      if (state === 'archived') { expect(live).toBe(0); expect(cl).toBe('GH001'); expect(ar.status).toBe(200) }
      else { expect(live).toBe(1); expect(cl).toBe('claimed'); expect(ar.status).toBe(409) }
    }
  })

  it('a room created in a building while it is being archived: exactly one outcome, never an active room in an archived building', async () => {
    for (let round = 0; round < 4; round++) {
      const siteId = await mkSite()
      const buildingId = await mkBuilding(siteId)
      const sa = await actor('SA')
      const [made, arch] = await Promise.all([
        send(createRoom, sa, { body: { siteId, buildingId, name: 'Late room', bedCodes: [`L-${round}-${randomUUID().slice(0, 4)}`] } }),
        send(archiveBuilding, sa, { id: buildingId, body: REASON }),
      ])
      const archived = (await row(`SELECT archived_at FROM building WHERE id = $1`, [buildingId]))[0].archived_at !== null
      const activeRooms = (await row(`SELECT count(*)::int AS n FROM room WHERE building_id = $1 AND archived_at IS NULL`, [buildingId]))[0].n
      if (archived) { expect(activeRooms).toBe(0); expect(made.status).toBe(409); expect(arch.status).toBe(200) }
      else { expect(activeRooms).toBe(1); expect(made.status).toBe(200); expect(arch.status).toBe(409) }
    }
  })

  it('a bed added to a room while it is being archived: same rule', async () => {
    for (let round = 0; round < 4; round++) {
      const p = await mkProperty({ beds: 0 })
      const aa = await actor('AA', { siteIds: [p.siteId] })
      const [made, arch] = await Promise.all([
        send(createBed, aa, { body: { roomId: p.roomId, code: `Q-${round}-${randomUUID().slice(0, 4)}` } }),
        send(archiveRoom, aa, { id: p.roomId, body: REASON }),
      ])
      const archived = (await row(`SELECT archived_at FROM room WHERE id = $1`, [p.roomId]))[0].archived_at !== null
      const activeBeds = (await row(`SELECT count(*)::int AS n FROM bed WHERE room_id = $1 AND archived_at IS NULL`, [p.roomId]))[0].n
      if (archived) { expect(activeBeds).toBe(0); expect(made.status).toBe(409) }
      else { expect(activeBeds).toBe(1); expect(made.status).toBe(200); expect(arch.status).toBe(409) }
    }
  })
})

describe('database backstops', () => {
  it('the database itself refuses to archive a bed that still has a live claim', async () => {
    const p = await mkProperty({ beds: 1 })
    await reserve(p.bedIds[0], '2026-11-01', '2026-11-10')
    await expect(admin().query(`UPDATE bed SET state = 'archived', archived_at = now() WHERE id = $1`, [p.bedIds[0]])).rejects.toMatchObject({ code: 'GH001' })
    expect((await bedRow(p.bedIds[0])).state).toBe('available')
  })

  it('the app role cannot delete beds, rooms, buildings or blocks', async () => {
    // The harness connects as app_role; DELETE has no grant anywhere (also covered by tests/db/app-role.test.ts).
    const { getPool } = await import('@/server/db/client')
    const p = await mkProperty({ beds: 1 })
    for (const t of ['bed', 'room', 'building', 'bed_block']) {
      await expect(getPool().query(`DELETE FROM ${t} WHERE site_id = $1`, [p.siteId])).rejects.toMatchObject({ code: '42501' })
    }
  })

  it('archiveStructure called directly with a stale view still re-checks under the locks', async () => {
    const p = await mkProperty({ beds: 1 })
    const actorObj = buildActor({ assignments: [{ id: 'x', role: 'SA', scopeKind: 'all', siteId: null, buildingId: null }], caps: [] }, 'SA')
    const user = (await actor('SA')).user
    const rc = { actor: actorObj, user: { id: user.id, username: user.username }, requestId: 'r', clock: getClock() }
    // Between "the screen said it was free" and "click", a reservation lands.
    await reserve(p.bedIds[0], '2026-11-01', '2026-11-10')
    const r = await archiveStructure(rc, 'bed', { id: p.bedIds[0], reason: 'Stale screen', cascade: false })
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.code).toBe('conflict')
  })
})
