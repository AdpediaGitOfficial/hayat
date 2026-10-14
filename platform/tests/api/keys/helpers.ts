/**
 * Arrangement helpers for the WP-I (keys and assets) tests. Data is created with the superuser pool, actions go through the real
 * commands (as app_role) or the real routes. Every call builds its own graph (site, room, bed, people), so files run in parallel
 * against one database. Never reuse a seeded resident.
 */
import { admin, makeUser, grantCapability, type TestUser } from '../harness'
import { rcFor } from '../rc'
import { FixedClock } from '@/server/clock'
import type { Capability, Role } from '@/domain/enums'
import type { RequestContext } from '@/server/command/context'
import { mkBed, mkProperty, mkRoom, mkStaff } from '../fixtures2'
import { mkItem, mkStayFor } from '../fixtures3'

export { mkBed, mkProperty, mkRoom, mkStaff, mkItem, mkStayFor, rcFor }

/** 2026-10-14 09:42 UTC: the default FixedClock, so day(0) is "today". */
export const NOW = Date.UTC(2026, 9, 14, 9, 42, 0)
export const DAY_MS = 86_400_000
export const day = (n: number) => new Date(Date.UTC(2026, 9, 14) + n * DAY_MS).toISOString().slice(0, 10)
export const newClock = () => new FixedClock(NOW)

export interface Person { user: TestUser; rc: RequestContext; staffId: string; userId: string; employeeId: string }

/** A person with an account (as a command context) holding `role` at the given sites, optionally with capabilities. */
export async function person(role: Role, o: { siteIds?: string[]; caps?: Capability[]; clock?: FixedClock } = {}): Promise<Person> {
  const roles = role === 'SA' ? [{ role, all: true }] : role === 'Res' ? [{ role }] : (o.siteIds ?? []).map(siteId => ({ role, siteId }))
  const user = await makeUser({ roles })
  for (const c of o.caps ?? []) await grantCapability(user.id, c)
  const emp = (await admin().query<{ employee_id: string }>(`SELECT employee_id FROM staff_profile WHERE id = $1`, [user.staffId])).rows[0].employee_id
  const sites: readonly string[] | 'all' = role === 'SA' ? 'all' : role === 'Res' ? [] : o.siteIds ?? []
  return { user, rc: rcFor(user.id, { role, sites, caps: o.caps ?? [], staffId: user.staffId }, o.clock ?? newClock()), staffId: user.staffId, userId: user.id, employeeId: emp }
}

/** The same person acting in another role (their staff record and account are unchanged). */
export const as = (p: Person, role: Role, o: { siteIds?: string[]; caps?: Capability[]; clock?: FixedClock } = {}): Person =>
  ({ ...p, rc: rcFor(p.userId, { role, sites: role === 'SA' ? 'all' : role === 'Res' ? [] : o.siteIds ?? [], caps: o.caps ?? [], staffId: p.staffId }, o.clock ?? (p.rc.clock as FixedClock)) })

/** A site with one building, one room and `beds` beds, plus its Accommodation Admin and Reception. */
export async function world(o: { beds?: number } = {}) {
  const p = await mkProperty({ beds: o.beds ?? 3 })
  const aa = await person('AA', { siteIds: [p.siteId] })
  const rec = await person('Rec', { siteIds: [p.siteId] })
  return { ...p, aa, rec }
}

/** A resident with an account and an active stay in the given bed. */
export async function resident(bedId: string, o: { from?: string } = {}) {
  const p = await person('Res')
  const s = await mkStayFor({ staffId: p.staffId, bedId, from: o.from ?? '2026-10-01' })
  return { ...p, ...s }
}

export async function itemRow(id: string) {
  return (await admin().query<{ id: string; status: string; holder_staff_id: string | null; issued_at: Date | null; due_back: string | null; replaced_by: string | null; archived_at: Date | null; code: string; bed_id: string | null; room_id: string | null; site_id: string; item_type: string }>(
    `SELECT id, status, holder_staff_id, issued_at, due_back::text, replaced_by, archived_at, code, bed_id, room_id, site_id, item_type FROM handover_item WHERE id = $1`, [id])).rows[0]
}
export async function events(itemId: string) {
  return (await admin().query<{ kind: string; staff_id: string | null; actor_user_id: string | null; on_behalf: boolean; note: string | null }>(
    `SELECT kind, staff_id, actor_user_id, on_behalf, note FROM handover_event WHERE item_id = $1 ORDER BY created_at, id`, [itemId])).rows
}
export async function auditsOf(entityId: string) {
  return (await admin().query<{ action: string; reason: string | null; actor_role: string | null; before: any; after: any; site_id: string | null }>(
    `SELECT action, reason, actor_role, before, after, site_id FROM audit_event WHERE entity_id = $1 ORDER BY seq`, [entityId])).rows
}
export async function stayStatus(stayId: string) {
  return (await admin().query<{ status: string; closed_at: Date | null }>(`SELECT status, closed_at FROM stay WHERE id = $1`, [stayId])).rows[0]
}
export async function checkOutDirectly(stayId: string, at: string) {
  await admin().query(`UPDATE stay SET status = 'checked_out', checked_out_at = $2 WHERE id = $1`, [stayId, at])
}
