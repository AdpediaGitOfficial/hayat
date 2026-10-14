/**
 * Arrangement for the WP-D tests. Commands are called directly with a RequestContext (rc.ts) so the acting identity,
 * sites and capabilities are explicit; the HTTP layer is covered by the permission contract and the route tests.
 */
import { admin, grantCapability, makeUser, signIn, type TestUser } from '../harness'
import { day, mkProperty, mkRequest, mkStaff } from '../fixtures2'
import { rcFor } from '../rc'
import { FixedClock } from '@/server/clock'
import type { Capability, Role } from '@/domain/enums'
import type { RequestContext } from '@/server/command/context'
import type { Result } from '@/server/command/result'

export { day, mkProperty, mkRequest, mkStaff }
export const CLOCK_START = Date.UTC(2026, 9, 14, 9, 42, 0)
export const newClock = () => new FixedClock(CLOCK_START)

export interface Who { user: TestUser; rc: RequestContext; staffId: string; cookie: () => Promise<string> }

/** A user holding `role` at the given sites (or everywhere for SA), with optional capability grants, as a ready-to-use context. */
export async function who(role: Role, o: { siteIds?: string[]; caps?: Capability[]; clock?: FixedClock } = {}): Promise<Who> {
  const roles = role === 'SA' ? [{ role, all: true }] : role === 'Res' ? [{ role }] : (o.siteIds ?? []).map(siteId => ({ role, siteId }))
  const user = await makeUser({ roles })
  for (const c of o.caps ?? []) await grantCapability(user.id, c)
  const rc = rcFor(user.id, { role, sites: role === 'SA' ? 'all' : (o.siteIds ?? []), caps: o.caps ?? [], staffId: user.staffId }, o.clock ?? newClock())
  return { user, rc, staffId: user.staffId, cookie: () => signIn(user) }
}

/** A user whose active mode is `role` but who also carries the Policy Approver capability, with staff gender/grade set. */
export async function setStaff(staffId: string, o: { gender?: 'male' | 'female' | null; grade?: number | null }) {
  await admin().query(`UPDATE staff_profile SET gender = $2, grade = $3 WHERE id = $1`, [staffId, o.gender === undefined ? 'male' : o.gender, o.grade === undefined ? 5 : o.grade])
}

export function must<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`expected ok, got ${r.code}: ${r.reason} (${r.next ?? ''})`)
  return r.data
}

export async function count(sql: string, params: unknown[] = []): Promise<number> {
  return Number((await admin().query(sql, params)).rows[0].count)
}
export const requestRow = async (id: string) => (await admin().query(`SELECT * FROM accommodation_request WHERE id = $1`, [id])).rows[0] as Record<string, any>
export const reservationsOf = async (requestId: string) => (await admin().query(`SELECT * FROM reservation WHERE request_id = $1`, [requestId])).rows as Record<string, any>[]
export const claimsOf = async (bedId: string) => (await admin().query(`SELECT * FROM bed_claim WHERE bed_id = $1 AND released_at IS NULL`, [bedId])).rows as Record<string, any>[]
export const auditActions = async (entityId: string) => (await admin().query(`SELECT action FROM audit_event WHERE entity_id = $1 ORDER BY seq`, [entityId])).rows.map(r => r.action as string)
export const notifCount = async (keyLike: string) => count(`SELECT count(*) FROM notification WHERE dedupe_key LIKE $1`, [keyLike])

/** A site with `beds` beds plus an AA for it and an open request for a resident without a login. */
export async function scenario(o: { beds?: number; gender?: 'male' | 'female' | null; grade?: number | null } = {}) {
  const p = await mkProperty({ beds: o.beds ?? 3 })
  const aa = await who('AA', { siteIds: [p.siteId] })
  const person = await mkStaff({ gender: o.gender === undefined ? 'male' : o.gender, grade: o.grade === undefined ? 5 : o.grade })
  const requestId = await mkRequest({ staffId: person.id, siteId: p.siteId, arrival: day(10), end: day(40) })
  return { ...p, aa, person, requestId }
}
