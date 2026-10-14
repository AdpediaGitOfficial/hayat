/**
 * Arrangement for the tests that FLIP A GLOBAL SETTING (the proposed policies P-03 to P-08, pending client sign-off). The shared test
 * database is used by every test file at once, so a file that turns `keys.enforce_office_hours` or `clearance.strict_item_owners` on
 * would change the behaviour of every other file running at the same moment. Those files run in a private database
 * (tests/api/access/isolated.ts) and build their people and property here.
 *
 * Do NOT import ../harness (or anything that does: helpers.ts, fixtures2.ts, fixtures3.ts) from a file that uses this: the harness
 * points the pool at the shared database.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { FixedClock } from '@/server/clock'
import type { Capability, Role } from '@/domain/enums'
import type { RequestContext } from '@/server/command/context'
import { rcFor } from '../rc'
import type { Isolated } from '../access/isolated'

export const NOW = Date.UTC(2026, 9, 14, 9, 42, 0)
export const DAY_MS = 86_400_000
export const uniq = (p = 'x') => `${p}-${randomUUID().slice(0, 8)}`
export const day = (n: number) => new Date(Date.UTC(2026, 9, 14) + n * DAY_MS).toISOString().slice(0, 10)
/** The smallest valid PNG the attachment sniffer accepts. */
export const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(24)])
export const clockAt = (iso8: string) => new FixedClock(new Date(iso8))

export interface IsoPerson { userId: string; staffId: string; employeeId: string; username: string; role: Role; rc: RequestContext }

export function isoWorld(iso: Isolated) {
  const q = iso.admin.query.bind(iso.admin)

  async function setConfig(key: string, value: unknown, siteId?: string) {
    await q(
      `INSERT INTO config_item (key, scope_site_id, version, value)
       VALUES ($1, $2, COALESCE((SELECT max(version) FROM config_item WHERE key = $1 AND scope_site_id IS NOT DISTINCT FROM $2), 0) + 1, $3::jsonb)`,
      [key, siteId ?? null, JSON.stringify(value)])
  }

  async function mkSite(tz = 'UTC') {
    return (await q<{ id: string }>(`INSERT INTO site (code, name, kind, time_zone) VALUES ($1, 'Iso site', 'villa', $2) RETURNING id`, [uniq('S'), tz])).rows[0].id
  }

  /** A site with one building, one room and `beds` beds. */
  async function mkProperty(o: { beds?: number; tz?: string } = {}) {
    const siteId = await mkSite(o.tz)
    const buildingId = (await q<{ id: string }>(`INSERT INTO building (site_id, code, name) VALUES ($1, $2, 'Block A') RETURNING id`, [siteId, uniq('B')])).rows[0].id
    const roomId = (await q<{ id: string }>(`INSERT INTO room (site_id, building_id, name, gender_policy) VALUES ($1, $2, $3, 'any') RETURNING id`, [siteId, buildingId, uniq('R')])).rows[0].id
    const bedIds: string[] = []
    for (let i = 0; i < (o.beds ?? 2); i++) {
      bedIds.push((await q<{ id: string }>(`INSERT INTO bed (site_id, room_id, code, state) VALUES ($1, $2, $3, 'available') RETURNING id`, [siteId, roomId, uniq('BED')])).rows[0].id)
    }
    return { siteId, buildingId, roomId, bedIds }
  }

  async function grantCapability(userId: string, capability: Capability) {
    const maker = await iso.makeUser({ roles: [{ role: 'SA', all: true }] })
    const checker = await iso.makeUser({ roles: [{ role: 'SA', all: true }] })
    await q(
      `INSERT INTO capability_grant (user_id, capability, reason, starts_at, expires_at, status, maker_id, checker_id, decided_at)
       VALUES ($1, $2, 'test', now() - interval '1 day', NULL, 'active', $3, $4, now())`, [userId, capability, maker.id, checker.id])
  }

  /** A person with a real account (password iso.PASSWORD) acting as `role` at the sites, optionally with capabilities. */
  async function person(role: Role, o: { siteIds?: string[]; caps?: Capability[]; clock?: FixedClock } = {}): Promise<IsoPerson> {
    const roles = role === 'SA' ? [{ role, all: true }] : role === 'Res' ? [{ role }] : (o.siteIds ?? []).map(siteId => ({ role, siteId }))
    const u = await iso.makeUser({ roles })
    for (const c of o.caps ?? []) await grantCapability(u.id, c)
    const employeeId = (await q<{ employee_id: string }>(`SELECT employee_id FROM staff_profile WHERE id = $1`, [u.staffId])).rows[0].employee_id
    const sites: readonly string[] | 'all' = role === 'SA' ? 'all' : role === 'Res' ? [] : o.siteIds ?? []
    return { userId: u.id, staffId: u.staffId, employeeId, username: u.username, role, rc: rcFor(u.id, { role, sites, caps: o.caps ?? [], staffId: u.staffId }, o.clock ?? new FixedClock(new Date(NOW))) }
  }

  /** The same person acting with another clock. */
  const withClock = (p: IsoPerson, clock: FixedClock): IsoPerson => ({ ...p, rc: { ...p.rc, clock } })

  /** An active stay in the bed (claim, stay, bed occupied). */
  async function mkStay(o: { staffId: string; bedId: string; from?: string; status?: 'active' | 'checked_out' }) {
    const claim = (await q<{ id: string }>(`INSERT INTO bed_claim (bed_id, kind, period) VALUES ($1, 'stay', $2::daterange) RETURNING id`, [o.bedId, `[${o.from ?? '2026-10-01'},)`])).rows[0].id
    const stay = (await q<{ id: string }>(`INSERT INTO stay (staff_id, bed_id, claim_id, status, stay_type, checked_in_at) VALUES ($1, $2, $3, 'active', 'permanent', '2026-10-01T10:00:00Z') RETURNING id`, [o.staffId, o.bedId, claim])).rows[0].id
    await q(`UPDATE bed SET state = 'occupied' WHERE id = $1`, [o.bedId])
    return { stayId: stay, claimId: claim }
  }

  async function mkItem(o: { siteId: string; bedId?: string; roomId?: string; category?: 'key' | 'asset'; itemType?: string; status?: string; holderStaffId?: string; code?: string }) {
    const status = o.status ?? (o.holderStaffId ? 'issued' : 'in_cabinet')
    return (await q<{ id: string }>(
      `INSERT INTO handover_item (category, item_type, code, site_id, room_id, bed_id, status, holder_staff_id, issued_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CASE WHEN $8::uuid IS NOT NULL THEN now() END) RETURNING id`,
      [o.category ?? 'key', o.itemType ?? 'room_key', o.code ?? uniq('K'), o.siteId, o.roomId ?? null, o.bedId ?? null, status, o.holderStaffId ?? null])).rows[0].id
  }

  /** A staff record with no login and no stay (or request) anywhere: the "never had a site" person of P-08. */
  async function mkStaff(name = 'Nobody ' + uniq('P')) {
    const r = await q<{ id: string; employee_id: string }>(`INSERT INTO staff_profile (employee_id, full_name) VALUES ($1, $2) RETURNING id, employee_id`, [uniq('E'), name])
    return { id: r.rows[0].id, employeeId: r.rows[0].employee_id }
  }

  const itemRow = async (id: string) => (await q<{ id: string; status: string; holder_staff_id: string | null; code: string }>(`SELECT id, status, holder_staff_id, code FROM handover_item WHERE id = $1`, [id])).rows[0]
  const events = async (itemId: string) => (await q<{ kind: string; staff_id: string | null; actor_user_id: string | null; on_behalf: boolean; note: string | null; after_hours: boolean }>(
    `SELECT kind, staff_id, actor_user_id, on_behalf, note, after_hours FROM handover_event WHERE item_id = $1 ORDER BY created_at, id`, [itemId])).rows
  const audits = async (entityId: string) => (await q<{ action: string; reason: string | null; actor_role: string | null; before: any; after: any; site_id: string | null }>(
    `SELECT action, reason, actor_role, before, after, site_id FROM audit_event WHERE entity_id = $1 ORDER BY seq`, [entityId])).rows
  const notes = async (prefix: string) => (await q<{ dedupe_key: string; kind: string; to_role: string | null; to_staff_id: string | null; site_id: string | null; text: string }>(
    `SELECT dedupe_key, kind, to_role, to_staff_id, site_id, text FROM notification WHERE dedupe_key LIKE $1 ORDER BY created_at`, [prefix + '%'])).rows
  const notesAbout = async (refId: string) => (await q<{ dedupe_key: string; kind: string; to_role: string | null; site_id: string | null }>(
    `SELECT dedupe_key, kind, to_role, site_id FROM notification WHERE ref_id = $1 ORDER BY created_at`, [refId])).rows
  const stayStatus = async (stayId: string) => (await q<{ status: string; closed_at: Date | null }>(`SELECT status, closed_at FROM stay WHERE id = $1`, [stayId])).rows[0]

  return { q, setConfig, mkSite, mkProperty, person, withClock, mkStay, mkItem, mkStaff, grantCapability, itemRow, events, audits, notes, notesAbout, stayStatus }
}
export type IsoWorld = ReturnType<typeof isoWorld>
