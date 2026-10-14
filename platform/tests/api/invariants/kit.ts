/**
 * Arrangement for the cross-cutting invariant tests that change global settings (the escalation backup, the re-confirmation list, the
 * proposed-policy switches) or install a trigger, so they run in a PRIVATE database (see tests/api/access/isolated.ts). The shared
 * database is used by every test file at once and a flipped setting would leak into them.
 * Do NOT import ../harness in a file that imports this: the harness points the pool at the shared database.
 *
 * `invKit(iso)` adds to the WP-F kit (sites, rooms, beds, stays, reservations): people with real role assignments and capability grants
 * who can also sign in, staff, requests with an explicit "waiting since", configuration versions.
 */
import { randomUUID } from 'node:crypto'
import { FixedClock } from '@/server/clock'
import { rcFor } from '../rc'
import type { Isolated } from '../access/isolated'
import { PASSWORD, signIn } from '../access/isolated'
import { kit as stayKit, NOW, DAY_MS, day } from '../stays/iso'
import { buildActor } from '@/server/auth/actor'
import type { Actor } from '@/server/policy'
import type { Capability, Role } from '@/domain/enums'
import type { RequestContext } from '@/server/command/context'

export { NOW, DAY_MS, day, PASSWORD }
/** 2026-10-14 09:42 UTC, a Wednesday: the SLA is 2 business days, so +2 days is the backup level and +5 days the escalation level. */
export const T0 = new Date(NOW)
export const atDays = (n: number) => new FixedClock(NOW + n * DAY_MS)

export interface Cast {
  userId: string
  staffId: string
  username: string
  password: string
  role: Role
  caps: Capability[]
  actor: Actor
  rc: (clock?: FixedClock) => RequestContext
  cookie: () => Promise<string>
}

export function invKit(iso: Isolated) {
  const base = stayKit(iso, new FixedClock(NOW))
  const { q, uniq } = base

  /** A signed-in-capable person: `role` (at `siteId`, everywhere for SA, own for Res) with active capability grants. */
  async function cast(role: Role, o: { siteId?: string | null; caps?: Capability[]; userId?: string } = {}): Promise<Cast> {
    const caps = o.caps ?? []
    const roles = role === 'SA' ? [{ role, all: true }] : role === 'Res' ? [{ role }] : o.siteId ? [{ role, siteId: o.siteId }] : [{ role }]
    const u = await iso.makeUser({ roles })
    if (caps.length) await grantCaps(u.id, caps)
    return castOf(u, role, caps, o.siteId)
  }
  /** The same login in another role/mode (a person who holds several), at the same or another site. */
  function castOf(u: { id: string; staffId: string; username: string; password: string }, role: Role, caps: Capability[], siteId?: string | null): Cast {
    const sites: readonly string[] | 'all' = role === 'SA' ? 'all' : role === 'Res' ? [] : siteId ? [siteId] : []
    const actor: Actor = { role, caps, sites, staffId: u.staffId }
    return {
      userId: u.id, staffId: u.staffId, username: u.username, password: u.password, role, caps, actor,
      rc: (clock = new FixedClock(NOW)) => rcFor(u.id, actor, clock),
      cookie: () => signIn(u),
    }
  }
  async function grantCaps(userId: string, caps: Capability[]) {
    const maker = await iso.makeUser({ roles: [{ role: 'SA', all: true }] })
    const checker = await iso.makeUser({ roles: [{ role: 'SA', all: true }] })
    for (const capability of caps) {
      await q(
        `INSERT INTO capability_grant (user_id, capability, reason, starts_at, expires_at, status, maker_id, checker_id, decided_at)
         VALUES ($1, $2, 'test', now() - interval '1 day', NULL, 'active', $3, $4, now())`, [userId, capability, maker.id, checker.id])
    }
  }

  async function staff(o: { gender?: 'male' | 'female' | null; grade?: number | null; status?: 'active' | 'left' } = {}) {
    const r = await q<{ id: string; employee_id: string }>(
      `INSERT INTO staff_profile (employee_id, full_name, gender, grade, employment_status, left_at)
       VALUES ($1, $2, $3, $4, $5, CASE WHEN $5 = 'left' THEN now() END) RETURNING id, employee_id`,
      [uniq('E'), 'Person ' + uniq('P'), o.gender === undefined ? 'male' : o.gender, o.grade === undefined ? 5 : o.grade, o.status ?? 'active'])
    return { id: r[0].id, employeeId: r[0].employee_id }
  }

  /** A submitted request that has been waiting since `since` (the approval clock runs from there). */
  async function request(o: { staffId: string; siteId: string; since?: Date; raisedByUserId?: string; status?: string; arrival?: string; end?: string | null }) {
    const r = await q<{ id: string }>(
      `INSERT INTO accommodation_request (staff_id, site_id, arrival_date, end_date, stay_type, status, created_at, updated_at, submitted_by, on_behalf)
       VALUES ($1, $2, $3, $4, 'contract', $5, $6, $6, $7, $8) RETURNING id`,
      [o.staffId, o.siteId, o.arrival ?? day(10), o.end === undefined ? day(100) : o.end, o.status ?? 'submitted', o.since ?? T0, o.raisedByUserId ?? null, !!o.raisedByUserId])
    return r[0].id
  }

  /** A configuration version, as the System configuration screen would write it (append-only). */
  async function setConfig(key: string, value: unknown, siteId?: string) {
    await q(
      `INSERT INTO config_item (key, scope_site_id, version, value)
       VALUES ($1, $2, COALESCE((SELECT max(version) FROM config_item WHERE key = $1 AND scope_site_id IS NOT DISTINCT FROM $2), 0) + 1, $3::jsonb)`,
      [key, siteId ?? null, JSON.stringify(value)])
  }

  /** A site with one room (gender policy as given) and `beds` beds. */
  async function property(o: { beds?: number; gender?: 'any' | 'male' | 'female' } = {}) {
    const siteId = await iso.newSite()
    const roomId = (await q<{ id: string }>(`INSERT INTO room (site_id, name, gender_policy) VALUES ($1, $2, $3) RETURNING id`, [siteId, uniq('R'), o.gender ?? 'any']))[0].id
    const bedIds: string[] = []
    for (let i = 0; i < (o.beds ?? 3); i++) bedIds.push((await q<{ id: string }>(`INSERT INTO bed (site_id, room_id, code) VALUES ($1, $2, $3) RETURNING id`, [siteId, roomId, uniq('B')]))[0].id)
    return { siteId, roomId, bedIds }
  }

  const auditOf = (entityId: string) => q<{ action: string; actor_user_id: string | null; actor_role: string | null; entity_type: string; entity_id: string | null; site_id: string | null; reason: string | null; before: any; after: any }>(
    `SELECT action, actor_user_id, actor_role, entity_type, entity_id, site_id, reason, before, after FROM audit_event WHERE entity_id = $1 ORDER BY seq`, [entityId])

  return { ...base, cast, castOf, grantCaps, staff, request, setConfig, property, auditOf, randomUUID }
}
export type InvKit = ReturnType<typeof invKit>
