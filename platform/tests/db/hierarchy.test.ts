import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { newPool, newSite, one, pgError, uniq } from './helpers'

let pool: Pool
beforeAll(() => { pool = newPool() })
afterAll(() => pool.end())

describe('Site -> [Building] -> [Floor] -> [Unit] -> Room -> Bed', () => {
  it('a villa is Site -> Room -> Bed: no building, floor or unit', async () => {
    const siteId = await newSite(pool)
    const room = await one<{ id: string; building_id: string | null; floor: string | null; unit: string | null }>(pool,
      `INSERT INTO room (site_id, name) VALUES ($1, 'Master') RETURNING id, building_id, floor, unit`, [siteId])
    expect(room).toMatchObject({ building_id: null, floor: null, unit: null })
    const bed = await one<{ state: string }>(pool,
      `INSERT INTO bed (site_id, room_id, code) VALUES ($1, $2, 'V1-A') RETURNING state`, [siteId, room.id])
    expect(bed.state).toBe('available')
  })

  it('a full tower is Site -> Building -> Floor -> Unit -> Room -> Bed', async () => {
    const siteId = await newSite(pool)
    const buildingId = (await one<{ id: string }>(pool, `INSERT INTO building (site_id, code, name) VALUES ($1, 'T1', 'Tower 1') RETURNING id`, [siteId])).id
    const roomId = (await one<{ id: string }>(pool,
      `INSERT INTO room (site_id, building_id, floor, unit, name) VALUES ($1, $2, '3', '3B', 'Room 1') RETURNING id`, [siteId, buildingId])).id
    await pool.query(`INSERT INTO bed (site_id, room_id, code) VALUES ($1, $2, 'T1-3B-1-A')`, [siteId, roomId])
  })

  it('a room cannot point at a building of another site', async () => {
    const siteA = await newSite(pool)
    const siteB = await newSite(pool)
    const buildingOfA = (await one<{ id: string }>(pool, `INSERT INTO building (site_id, code, name) VALUES ($1, 'B', 'B') RETURNING id`, [siteA])).id
    const err = await pgError(pool.query(`INSERT INTO room (site_id, building_id, name) VALUES ($1, $2, 'R')`, [siteB, buildingOfA]))
    expect(err.code).toBe('23503')
  })

  it('a bed cannot claim a different site than its room', async () => {
    const siteA = await newSite(pool)
    const siteB = await newSite(pool)
    const roomOfA = (await one<{ id: string }>(pool, `INSERT INTO room (site_id, name) VALUES ($1, 'R') RETURNING id`, [siteA])).id
    expect((await pgError(pool.query(`INSERT INTO bed (site_id, room_id, code) VALUES ($1, $2, 'X')`, [siteB, roomOfA]))).code).toBe('23503')
  })

  it('room and bed names are unique within their place, case-insensitively, even without a building', async () => {
    const siteId = await newSite(pool)
    await pool.query(`INSERT INTO room (site_id, name) VALUES ($1, 'Room 1')`, [siteId])
    expect((await pgError(pool.query(`INSERT INTO room (site_id, name) VALUES ($1, ' room 1 ')`, [siteId]))).code).toBe('23505')
    const roomId = (await one<{ id: string }>(pool, `INSERT INTO room (site_id, name) VALUES ($1, 'Room 2') RETURNING id`, [siteId])).id
    const code = uniq('BED')
    await pool.query(`INSERT INTO bed (site_id, room_id, code) VALUES ($1, $2, $3)`, [siteId, roomId, code])
    expect((await pgError(pool.query(`INSERT INTO bed (site_id, room_id, code) VALUES ($1, $2, $3)`, [siteId, roomId, code.toLowerCase()]))).code).toBe('23505')
  })

  it('archiving is the only way out: the archived flag and state must agree', async () => {
    const siteId = await newSite(pool)
    const roomId = (await one<{ id: string }>(pool, `INSERT INTO room (site_id, name) VALUES ($1, 'R') RETURNING id`, [siteId])).id
    const bedId = (await one<{ id: string }>(pool, `INSERT INTO bed (site_id, room_id, code) VALUES ($1, $2, 'A') RETURNING id`, [siteId, roomId])).id
    expect((await pgError(pool.query(`UPDATE bed SET state = 'archived' WHERE id = $1`, [bedId]))).constraint).toBe('bed_archive_consistent')
    await pool.query(`UPDATE bed SET state = 'archived', archived_at = now() WHERE id = $1`, [bedId])
  })
})

describe('role scope and capability grants', () => {
  it('a site-scoped role must name a site; an all-scope role must not', async () => {
    const siteId = await newSite(pool)
    const userId = (await one<{ id: string }>(pool, `INSERT INTO user_account (username) VALUES ($1) RETURNING id`, [uniq('u')])).id
    expect((await pgError(pool.query(`INSERT INTO role_assignment (user_id, role, scope_kind) VALUES ($1, 'AA', 'site')`, [userId]))).constraint).toBe('role_scope_shape')
    expect((await pgError(pool.query(`INSERT INTO role_assignment (user_id, role, scope_kind, site_id) VALUES ($1, 'SA', 'all', $2)`, [userId, siteId]))).constraint).toBe('role_scope_shape')
    await pool.query(`INSERT INTO role_assignment (user_id, role, scope_kind, site_id) VALUES ($1, 'AA', 'site', $2)`, [userId, siteId])
    await pool.query(`INSERT INTO role_assignment (user_id, role, scope_kind) VALUES ($1, 'Res', 'own')`, [userId])
  })

  it('maker-checker: the checker cannot be the maker; an active grant needs a checker and a reason', async () => {
    const maker = (await one<{ id: string }>(pool, `INSERT INTO user_account (username) VALUES ($1) RETURNING id`, [uniq('mk')])).id
    const user = (await one<{ id: string }>(pool, `INSERT INTO user_account (username) VALUES ($1) RETURNING id`, [uniq('us')])).id
    const insert = (checker: string | null, status: string, reason = 'cover for leave') => pool.query(
      `INSERT INTO capability_grant (user_id, capability, reason, status, maker_id, checker_id, decided_at)
       VALUES ($1, 'PolicyApprover', $2, $3, $4, $5, CASE WHEN $5::uuid IS NULL THEN NULL ELSE now() END)`, [user, reason, status, maker, checker])
    expect((await pgError(insert(maker, 'active'))).constraint).toBe('grant_maker_not_checker')
    expect((await pgError(insert(null, 'active'))).constraint).toBe('grant_active_needs_checker')
    expect((await pgError(insert(null, 'pending', '  '))).code).toBe('23514')
    await insert(null, 'pending')
  })
})
