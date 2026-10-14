/**
 * Arrangement helpers for the property tests. Data is created with the superuser pool (the way Stage 2 and the migration import
 * will eventually create claims), actions go through the real routes as app_role.
 */
import { admin, call, grantCapability, makeUser, signIn, uniq, type Reply, type TestUser } from '../harness'
import type { Capability, Role } from '@/domain/enums'

type Handler = Parameters<typeof call>[0]

export interface Actor { user: TestUser; cookie: string }

/** Signs in a user holding `role` for the given sites (or everywhere for SA), optionally with capability grants. */
export async function actor(role: Role, o: { siteIds?: string[]; caps?: Capability[] } = {}): Promise<Actor> {
  const roles = role === 'SA' ? [{ role, all: true }] : role === 'Res' ? [{ role }] : (o.siteIds ?? []).map(siteId => ({ role, siteId }))
  const user = await makeUser({ roles })
  for (const c of o.caps ?? []) await grantCapability(user.id, c)
  return { user, cookie: await signIn(user) }
}

export const send = (h: Handler, a: Actor | undefined, o: { method?: string; body?: unknown; id?: string; path?: string } = {}): Promise<Reply> =>
  call(h, { method: o.method, body: o.body, cookie: a?.cookie, params: o.id ? { id: o.id } : undefined, path: o.path ?? '/api/v1/property/x' })

/* ---------------- structure ---------------- */

export async function mkSite(o: { name?: string; tz?: string } = {}): Promise<string> {
  return (await admin().query<{ id: string }>(
    `INSERT INTO site (code, name, kind, time_zone) VALUES ($1, $2, 'apartment', $3) RETURNING id`, [uniq('S'), o.name ?? 'Test site', o.tz ?? 'UTC'])).rows[0].id
}
export async function mkBuilding(siteId: string, name = 'Block A'): Promise<string> {
  return (await admin().query<{ id: string }>(`INSERT INTO building (site_id, code, name) VALUES ($1, $2, $3) RETURNING id`, [siteId, uniq('B'), name])).rows[0].id
}
export async function mkRoom(siteId: string, o: { buildingId?: string | null; name?: string; gender?: 'any' | 'male' | 'female' } = {}): Promise<string> {
  return (await admin().query<{ id: string }>(
    `INSERT INTO room (site_id, building_id, name, gender_policy) VALUES ($1, $2, $3, $4) RETURNING id`,
    [siteId, o.buildingId ?? null, o.name ?? uniq('R'), o.gender ?? 'any'])).rows[0].id
}
export async function mkBed(roomId: string, o: { state?: string; code?: string } = {}): Promise<string> {
  const room = (await admin().query<{ site_id: string }>(`SELECT site_id FROM room WHERE id = $1`, [roomId])).rows[0]
  return (await admin().query<{ id: string }>(
    `INSERT INTO bed (site_id, room_id, code, state, archived_at) VALUES ($1, $2, $3, $4, CASE WHEN $4 = 'archived' THEN now() END) RETURNING id`,
    [room.site_id, roomId, o.code ?? uniq('BED'), o.state ?? 'available'])).rows[0].id
}

/** A site with one building, one room and `beds` beds. */
export async function mkProperty(o: { beds?: number; building?: boolean } = {}) {
  const siteId = await mkSite()
  const buildingId = o.building === false ? null : await mkBuilding(siteId)
  const roomId = await mkRoom(siteId, { buildingId })
  const bedIds: string[] = []
  for (let i = 0; i < (o.beds ?? 2); i++) bedIds.push(await mkBed(roomId))
  return { siteId, buildingId, roomId, bedIds }
}

/* ---------------- claims, stays, state ---------------- */

async function staff(): Promise<string> {
  return (await admin().query<{ id: string }>(`INSERT INTO staff_profile (employee_id, full_name) VALUES ($1, $2) RETURNING id`, [uniq('E'), 'Resident ' + uniq('P')])).rows[0].id
}

/** A live reservation on the bed for [from, to) (to = departure day, D-103). */
export async function reserve(bedId: string, from: string, to?: string): Promise<{ claimId: string; staffId: string }> {
  const staffId = await staff()
  const claim = (await admin().query<{ id: string }>(
    `INSERT INTO bed_claim (bed_id, kind, period) VALUES ($1, 'reservation', $2::daterange) RETURNING id`, [bedId, to ? `[${from},${to})` : `[${from},)`])).rows[0]
  await admin().query(
    `INSERT INTO reservation (staff_id, bed_id, claim_id, eta, source, stay_type) VALUES ($1, $2, $3, $4, 'request', 'permanent')`,
    [staffId, bedId, claim.id, `${from}T12:00:00Z`])
  return { claimId: claim.id, staffId }
}

/** The bed is occupied: an active stay holds an open-ended claim and the bed state follows. */
export async function occupy(bedId: string, from = '2026-10-01'): Promise<{ claimId: string; staffId: string }> {
  const staffId = await staff()
  const claim = (await admin().query<{ id: string }>(
    `INSERT INTO bed_claim (bed_id, kind, period) VALUES ($1, 'stay', $2::daterange) RETURNING id`, [bedId, `[${from},)`])).rows[0]
  await admin().query(`INSERT INTO stay (staff_id, bed_id, claim_id, status, stay_type) VALUES ($1, $2, $3, 'active', 'permanent')`, [staffId, bedId, claim.id])
  await admin().query(`UPDATE bed SET state = 'occupied' WHERE id = $1`, [bedId])
  return { claimId: claim.id, staffId }
}

export async function bedRow(bedId: string) {
  return (await admin().query(`SELECT state, state_reason, archived_at FROM bed WHERE id = $1`, [bedId])).rows[0] as { state: string; state_reason: string | null; archived_at: Date | null }
}
export async function setState(bedId: string, state: string) {
  await admin().query(`UPDATE bed SET state = $2 WHERE id = $1`, [bedId, state])
}

/** Audit rows written for an entity, oldest first. */
export async function audits(entityId: string): Promise<{ action: string; reason: string | null; actor_role: string | null; before: any; after: any; site_id: string | null }[]> {
  return (await admin().query(`SELECT action, reason, actor_role, before, after, site_id FROM audit_event WHERE entity_id = $1 ORDER BY seq`, [entityId])).rows
}
/** Number of audit rows for a site: the tests run in parallel against one database, so never count globally. */
export async function auditCount(siteId: string): Promise<number> {
  return Number((await admin().query(`SELECT count(*) FROM audit_event WHERE site_id = $1`, [siteId])).rows[0].count)
}
