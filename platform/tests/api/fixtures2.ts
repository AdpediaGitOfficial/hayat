/**
 * Arrangement helpers for the Stage 2 tests. Data is created with the superuser pool, actions go through the real
 * routes or commands as app_role. Everything creates its own graph, so test files can run in parallel against one database.
 * Re-exports the property helpers (site, building, room, bed, reserve, occupy, setState).
 */
import { admin, uniq } from './harness'
export { mkBed, mkBuilding, mkProperty, mkRoom, mkSite, occupy, reserve, setState, actor, send } from './property/helpers'

export const DAY = 86_400_000
export const day = (offsetDays: number, from = Date.UTC(2026, 9, 14)) => new Date(from + offsetDays * DAY).toISOString().slice(0, 10)

export async function mkStaff(o: { gender?: 'male' | 'female' | null; grade?: number | null; status?: 'active' | 'left'; name?: string } = {}) {
  const r = await admin().query<{ id: string; employee_id: string }>(
    `INSERT INTO staff_profile (employee_id, full_name, gender, grade, employment_status, left_at)
     VALUES ($1, $2, $3, $4, $5, CASE WHEN $5 = 'left' THEN now() END) RETURNING id, employee_id`,
    [uniq('E'), o.name ?? 'Resident ' + uniq('P'), o.gender === undefined ? 'male' : o.gender, o.grade === undefined ? 5 : o.grade, o.status ?? 'active'])
  return { id: r.rows[0].id, employeeId: r.rows[0].employee_id }
}

/** Writes a configuration version directly (append-only table: always a new version). */
export async function setConfigValue(key: string, value: unknown, siteId?: string) {
  await admin().query(
    `INSERT INTO config_item (key, scope_site_id, version, value)
     VALUES ($1, $2, COALESCE((SELECT max(version) FROM config_item WHERE key = $1 AND scope_site_id IS NOT DISTINCT FROM $2), 0) + 1, $3::jsonb)`,
    [key, siteId ?? null, JSON.stringify(value)])
}

export async function mkRequest(o: { staffId: string; siteId: string; arrival?: string; end?: string | null; status?: string; createdAt?: Date; stayType?: string }) {
  const r = await admin().query<{ id: string }>(
    `INSERT INTO accommodation_request (staff_id, site_id, arrival_date, end_date, stay_type, status, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, now())) RETURNING id`,
    [o.staffId, o.siteId, o.arrival ?? day(10), o.end === undefined ? day(100) : o.end, o.stayType ?? 'contract', o.status ?? 'submitted', o.createdAt ?? null])
  return r.rows[0].id
}

/** A Policy Approver exception for this person (gender or grade), valid for any site unless one is given. */
export async function mkException(o: { staffId: string; kind: 'gender' | 'grade'; grantedBy: string; siteId?: string; requestId?: string }) {
  const r = await admin().query<{ id: string }>(
    `INSERT INTO eligibility_exception (staff_id, kind, site_id, request_id, granted_by, reason, evidence) VALUES ($1, $2, $3, $4, $5, 'test', 'test evidence') RETURNING id`,
    [o.staffId, o.kind, o.siteId ?? null, o.requestId ?? null, o.grantedBy])
  return r.rows[0].id
}

export async function liveClaims(bedId: string) {
  return (await admin().query<{ id: string; kind: string; period: string }>(
    `SELECT id, kind, period::text FROM bed_claim WHERE bed_id = $1 AND released_at IS NULL ORDER BY lower(period)`, [bedId])).rows
}
export async function notificationsByKey(prefix: string) {
  return (await admin().query<{ dedupe_key: string; kind: string; to_role: string | null; to_staff_id: string | null; text: string }>(
    `SELECT dedupe_key, kind, to_role, to_staff_id, text FROM notification WHERE dedupe_key LIKE $1 ORDER BY created_at`, [prefix + '%'])).rows
}
