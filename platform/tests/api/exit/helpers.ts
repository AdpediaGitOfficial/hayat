/**
 * Arrangement for the WP-H (exit, clearance, rehire) tests. People are real accounts created with the superuser pool and signed in
 * through the real login, commands are called with a RequestContext on a FixedClock, routes with the real handlers. Every test builds
 * its own sites and people, so files run in parallel against one database.
 */
import { admin, call, grantCapability, makeUser, PASSWORD, signIn, type TestUser } from '../harness'
import { FixedClock } from '@/server/clock'
import type { Capability, Role } from '@/domain/enums'
import type { RequestContext } from '@/server/command/context'
import { rcFor } from '../rc'
import { mkItem, mkProperty, mkStayFor, mkStaff } from '../fixtures3'

export { admin, call, PASSWORD, mkItem, mkProperty, mkStayFor, mkStaff }
export { mkReservation } from '../stays/helpers'
export const T0 = new Date('2026-10-14T09:42:00Z')
export const DAY_MS = 86_400_000
export const clockAt = (offsetDays = 0, extraMs = 0) => new FixedClock(new Date(T0.getTime() + offsetDays * DAY_MS + extraMs))

export interface Who {
  user: TestUser
  role: Role
  caps: Capability[]
  siteIds: string[] | 'all'
  cookie: string
  rc: (clock?: FixedClock) => RequestContext
}

export async function who(role: Role, o: { siteIds?: string[]; caps?: Capability[] } = {}): Promise<Who> {
  const caps = o.caps ?? []
  const siteIds: string[] | 'all' = role === 'SA' ? 'all' : role === 'Res' ? [] : o.siteIds ?? []
  const roles = role === 'SA' ? [{ role, all: true }] : role === 'Res' ? [{ role }] : (siteIds as string[]).map(siteId => ({ role, siteId }))
  const user = await makeUser({ roles })
  for (const c of caps) await grantCapability(user.id, c)
  return {
    user, role, caps, siteIds, cookie: await signIn(user),
    rc: clock => rcFor(user.id, { role, caps, sites: siteIds, staffId: user.staffId }, clock ?? clockAt()),
  }
}

/** Site A with six beds and a full cast; site B with two beds and its own AA (for scope tests). */
export async function world(beds = 6) {
  const p = await mkProperty({ beds })
  const other = await mkProperty({ beds: 2 })
  const aa = await who('AA', { siteIds: [p.siteId] })
  const rec = await who('Rec', { siteIds: [p.siteId] })
  const mc = await who('MC', { siteIds: [p.siteId] })
  const pa = await who('Mgr', { siteIds: [p.siteId], caps: ['PolicyApprover'] })
  const sa = await who('SA')
  const aaOther = await who('AA', { siteIds: [other.siteId] })
  return { ...p, other, aa, rec, mc, pa, sa, aaOther }
}
export type World = Awaited<ReturnType<typeof world>>

export interface Resident { user: TestUser; staffId: string; employeeId: string; cookie: string; stayId?: string; claimId?: string; bedId?: string }

/** A resident with a login. With `bedId` they are in that bed (an active stay, the bed Occupied). */
export async function resident(o: { bedId?: string; status?: 'active' | 'left' } = {}): Promise<Resident> {
  const user = await makeUser({ roles: [{ role: 'Res' }] })
  const employeeId = (await admin().query<{ employee_id: string }>(`SELECT employee_id FROM staff_profile WHERE id = $1`, [user.staffId])).rows[0].employee_id
  const r: Resident = { user, staffId: user.staffId, employeeId, cookie: await signIn(user) }
  if (o.bedId) {
    const s = await mkStayFor({ staffId: user.staffId, bedId: o.bedId, from: '2026-10-01' })
    await admin().query(`UPDATE stay SET checked_in_at = '2026-10-01T10:00:00Z' WHERE id = $1`, [s.stayId])
    r.stayId = s.stayId; r.claimId = s.claimId; r.bedId = o.bedId
  }
  return r
}

export async function bedState(bedId: string): Promise<string> {
  return (await admin().query<{ state: string }>(`SELECT state FROM bed WHERE id = $1`, [bedId])).rows[0].state
}
export async function stayRow(stayId: string) {
  return (await admin().query<{ id: string; status: string; claim_id: string; bed_id: string; checked_out_at: Date | null; closed_at: Date | null }>(`SELECT id, status, claim_id, bed_id, checked_out_at, closed_at FROM stay WHERE id = $1`, [stayId])).rows[0]
}
export async function staffRow(staffId: string) {
  return (await admin().query<{ employment_status: string; left_at: Date | null; left_effective: string | null; employee_id: string }>(`SELECT employment_status, left_at, left_effective::text, employee_id FROM staff_profile WHERE id = $1`, [staffId])).rows[0]
}
export async function accountRow(userId: string) {
  return (await admin().query<{ status: string; revoked_at: Date | null }>(`SELECT status, revoked_at FROM user_account WHERE id = $1`, [userId])).rows[0]
}
export async function liveSessions(userId: string): Promise<number> {
  return Number((await admin().query(`SELECT count(*) FROM session WHERE user_id = $1 AND revoked_at IS NULL`, [userId])).rows[0].count)
}
export async function caseOf(staffId: string) {
  return (await admin().query<{ id: string; status: string; stay_id: string | null; site_id: string | null; effective_date: string; due_date: string; reason: string; opened_by: string; cleared_at: Date | null }>(
    `SELECT id, status, stay_id, site_id, effective_date::text, due_date::text, reason, opened_by, cleared_at FROM clearance_case WHERE staff_id = $1 ORDER BY opened_at`, [staffId])).rows
}
export async function itemsOf(caseId: string) {
  return (await admin().query<{ id: string; kind: string; label: string; mandatory: boolean; owner: string; status: string; done_by: string | null; on_behalf_of_staff_id: string | null; note: string | null; handover_item_id: string | null; checklist_key: string | null }>(
    `SELECT id, kind, label, mandatory, owner, status, done_by, on_behalf_of_staff_id, note, handover_item_id, checklist_key FROM clearance_item WHERE case_id = $1 ORDER BY position`, [caseId])).rows
}
export async function eventsOf(caseId: string) {
  return (await admin().query<{ kind: string; item_id: string | null; actor_user_id: string | null; on_behalf_of_staff_id: string | null; note: string | null }>(
    `SELECT kind, item_id, actor_user_id, on_behalf_of_staff_id, note FROM clearance_event WHERE case_id = $1 ORDER BY seq`, [caseId])).rows
}
export async function auditFor(entityId: string) {
  return (await admin().query<{ action: string; reason: string | null; actor_role: string | null; before: any; after: any }>(
    `SELECT action, reason, actor_role, before, after FROM audit_event WHERE entity_id = $1 ORDER BY seq`, [entityId])).rows
}
export async function notifs(prefix: string) {
  return (await admin().query<{ dedupe_key: string; kind: string; to_role: string | null; to_staff_id: string | null; site_id: string | null; text: string }>(
    `SELECT dedupe_key, kind, to_role, to_staff_id, site_id, text FROM notification WHERE dedupe_key LIKE $1 ORDER BY created_at, dedupe_key`, [prefix + '%'])).rows
}
export async function claimRow(claimId: string) {
  return (await admin().query<{ released_at: Date | null; release_reason: string | null }>(`SELECT released_at, release_reason FROM bed_claim WHERE id = $1`, [claimId])).rows[0]
}

/** A snapshot of every table Mark as Left touches for a person, to prove that a failed or refused call changed NOTHING. */
export async function snapshot(staffId: string, userId?: string) {
  const q = async (sql: string, args: unknown[] = [staffId]) => (await admin().query(sql, args)).rows
  return JSON.stringify({
    staff: await q(`SELECT employment_status, left_at, left_effective FROM staff_profile WHERE id = $1`),
    account: userId ? await q(`SELECT status, revoked_at FROM user_account WHERE id = $1`, [userId]) : null,
    sessions: userId ? await q(`SELECT id, revoked_at, revoked_reason FROM session WHERE user_id = $1 ORDER BY id`, [userId]) : null,
    reservations: await q(`SELECT id, status, cancel_reason FROM reservation WHERE staff_id = $1 ORDER BY id`),
    claims: await q(`SELECT c.id, c.released_at FROM bed_claim c WHERE c.id IN (SELECT claim_id FROM reservation WHERE staff_id = $1 UNION SELECT claim_id FROM stay WHERE staff_id = $1 UNION SELECT claim_id FROM bed_offer WHERE staff_id = $1) ORDER BY c.id`),
    stays: await q(`SELECT id, status FROM stay WHERE staff_id = $1 ORDER BY id`),
    waitlist: await q(`SELECT id, status, close_reason FROM waitlist_entry WHERE staff_id = $1 ORDER BY id`),
    offers: await q(`SELECT id, status FROM bed_offer WHERE staff_id = $1 ORDER BY id`),
    requests: await q(`SELECT id, status FROM accommodation_request WHERE staff_id = $1 ORDER BY id`),
    transfers: await q(`SELECT id, status FROM transfer_request WHERE staff_id = $1 OR other_staff_id = $1 ORDER BY id`),
    extensions: await q(`SELECT id, status FROM extension_request WHERE staff_id = $1 ORDER BY id`),
    checkouts: await q(`SELECT id, status FROM checkout_request WHERE staff_id = $1 ORDER BY id`),
    emergency: await q(`SELECT id, status FROM emergency_checkin WHERE staff_id = $1 ORDER BY id`),
    cases: await q(`SELECT id, status FROM clearance_case WHERE staff_id = $1 ORDER BY id`),
    items: await q(`SELECT i.id, i.status FROM clearance_item i JOIN clearance_case c ON c.id = i.case_id WHERE c.staff_id = $1 ORDER BY i.id`),
    audit: await q(`SELECT count(*)::int AS n FROM audit_event WHERE entity_id = $1`),
  })
}


/**
 * A resident in bed 0 with everything Mark as Left has to clean up: a future reservation (bed 1), a waitlist entry with a pending
 * offer (bed 2), an open request, a pending transfer, extension and checkout request. A fresh graph per call.
 */
export async function busyResident(w: World) {
  const { mkReservation } = await import('../stays/helpers')
  const r = await resident({ bedId: w.bedIds[0] })
  const rsv = await mkReservation({ bedId: w.bedIds[1], staffId: r.staffId, from: '2026-11-20', to: '2026-12-20' })
  // an offered waitlist entry: the entry, the hold on bed 2 and the offer
  const entry = (await admin().query<{ id: string }>(
    `INSERT INTO waitlist_entry (staff_id, site_id, expires_at, arrival_date, stay_type, status) VALUES ($1, $2, '2026-11-30', '2026-11-01', 'contract', 'offered') RETURNING id`,
    [r.staffId, w.siteId])).rows[0].id
  const hold = (await admin().query<{ id: string }>(`INSERT INTO bed_claim (bed_id, kind, period) VALUES ($1, 'offer_hold', '[2026-11-01,2026-12-01)') RETURNING id`, [w.bedIds[2]])).rows[0].id
  const offer = (await admin().query<{ id: string }>(
    `INSERT INTO bed_offer (staff_id, waitlist_entry_id, bed_id, claim_id, status, expires_at) VALUES ($1, $2, $3, $4, 'pending', '2026-10-20') RETURNING id`,
    [r.staffId, entry, w.bedIds[2], hold])).rows[0].id
  const req = (await admin().query<{ id: string }>(
    `INSERT INTO accommodation_request (staff_id, site_id, arrival_date, end_date, stay_type, status) VALUES ($1, $2, '2026-12-01', '2027-01-01', 'contract', 'pending_approval') RETURNING id`,
    [r.staffId, w.siteId])).rows[0].id
  const transfer = (await admin().query<{ id: string }>(
    `INSERT INTO transfer_request (kind, site_id, destination_site_id, stay_id, staff_id, from_bed_id, to_bed_id, reason, status) VALUES ('transfer', $1, $1, $2, $3, $4, $5, 'Closer to work', 'requested') RETURNING id`,
    [w.siteId, r.stayId, r.staffId, w.bedIds[0], w.bedIds[3]])).rows[0].id
  const ext = (await admin().query<{ id: string }>(
    `INSERT INTO extension_request (site_id, stay_id, staff_id, current_end, new_end, added_days, status) VALUES ($1, $2, $3, '2026-12-01', '2026-12-31', 30, 'requested') RETURNING id`,
    [w.siteId, r.stayId, r.staffId])).rows[0].id
  const checkout = (await admin().query<{ id: string }>(
    `INSERT INTO checkout_request (site_id, stay_id, staff_id, departure_date, status) VALUES ($1, $2, $3, '2026-11-15', 'requested') RETURNING id`,
    [w.siteId, r.stayId, r.staffId])).rows[0].id
  return { r, rsv, entry, hold, offer, req, transfer, ext, checkout }
}

export const status = async (table: string, id: string) => (await admin().query<{ status: string }>(`SELECT status FROM ${table} WHERE id = $1`, [id])).rows[0].status
