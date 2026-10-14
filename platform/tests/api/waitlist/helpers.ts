/**
 * Arrangement for the waitlist tests. Data is created with the superuser pool; actions go through the commands (with a FixedClock)
 * or the real routes (with a session) as app_role.
 *
 * TIME: sweeps are global, and every test file shares one database. So these tests live in the PAST, each test in its own window
 * 400 days apart. Tests that only call commands start in 2020; tests that RUN SWEEPS start in 2000 (`window({ sweeps: true })`),
 * so a sweep clock never reaches anything created by another test file (2020 and 2026 are in its future). Never run a sweep here
 * with a clock after 2019.
 */
import { admin, grantCapability, makeUser, signIn, type TestUser } from '../harness'
import { DAY, mkProperty, mkStaff } from '../fixtures2'
import { rcFor } from '../rc'
import { FixedClock } from '@/server/clock'
import type { Capability, Role } from '@/domain/enums'
import type { RequestContext } from '@/server/command/context'

export { DAY, mkProperty, mkStaff }
export const HOUR = 3_600_000

const BASE = Date.UTC(2020, 0, 6, 9, 0, 0) // Monday
const SWEEP_BASE = Date.UTC(2000, 0, 3, 9, 0, 0) // Monday. Only the sweep tests run sweeps, and they live here, before everything else.
let next = 0
/** A clock in its own window of the past; `day(n)` is n days after its start as 'YYYY-MM-DD'. `sweeps: true` for tests that run sweeps. */
export function window(o: { sweeps?: boolean } = {}) {
  const k = next++
  const clock = new FixedClock((o.sweeps ? SWEEP_BASE : BASE) + k * 400 * DAY)
  const day = (n: number) => new Date(clock.nowMs() + n * DAY).toISOString().slice(0, 10)
  return { clock, day, k }
}
export type Window = ReturnType<typeof window>

export interface Staffer { user: TestUser; rc: (clock: FixedClock) => RequestContext; staffId: string }

/** A user with a role (and optional capabilities) for the given sites; `rc(clock)` gives a request context for direct command calls. */
export async function person(role: Role, o: { siteIds?: string[]; caps?: Capability[] } = {}): Promise<Staffer> {
  const roles = role === 'SA' ? [{ role, all: true }] : role === 'Res' ? [{ role }] : (o.siteIds ?? []).map(siteId => ({ role, siteId }))
  const user = await makeUser({ roles })
  for (const c of o.caps ?? []) await grantCapability(user.id, c)
  return {
    user, staffId: user.staffId,
    rc: clock => rcFor(user.id, { role, caps: o.caps ?? [], sites: role === 'SA' ? 'all' : o.siteIds ?? [], staffId: user.staffId }, clock),
  }
}
export async function cookieOf(p: Staffer) { return signIn(p.user) }

/** A site with `beds` ready beds in one room, an Accommodation Admin and Reception for it, and a resident (staff + account). */
export async function world(o: { beds?: number } = {}) {
  const prop = await mkProperty({ beds: o.beds ?? 3 })
  const aa = await person('AA', { siteIds: [prop.siteId] })
  const rec = await person('Rec', { siteIds: [prop.siteId] })
  const pa = await person('AA', { siteIds: [prop.siteId], caps: ['PolicyApprover'] })
  const res = await person('Res')
  return { ...prop, aa, rec, pa, res }
}

/** A second resident with an account. */
export const resident = () => person('Res')

export async function one<T = Record<string, unknown>>(sql: string, args: unknown[] = []): Promise<T> {
  return (await admin().query(sql, args)).rows[0] as T
}
export const entryRow = (id: string) => one<{ status: string; close_reason: string | null; queue_ts: Date; expires_at: Date; declines: number; skip_bed_ids: string[]; reminders_sent: number[]; priority: string | null; renewals: number }>(`SELECT * FROM waitlist_entry WHERE id = $1`, [id])
export const offerRow = (id: string) => one<{ status: string; claim_id: string; delivered_at: Date | null; delivered_via: string | null; expires_at: Date | null; follow_up_sent_at: Date | null; accepted_on_behalf: boolean; accepted_by: string | null; consent_note: string | null; staff_id: string; bed_id: string }>(`SELECT * FROM bed_offer WHERE id = $1`, [id])
export const claimRow = (id: string) => one<{ kind: string; released_at: Date | null; release_reason: string | null; period: string }>(`SELECT kind, released_at, release_reason, period::text FROM bed_claim WHERE id = $1`, [id])
export const audits = async (entityId: string) => (await admin().query(`SELECT action, actor_role, actor_user_id, reason, before, after FROM audit_event WHERE entity_id = $1 ORDER BY seq`, [entityId])).rows as { action: string; actor_role: string | null; actor_user_id: string | null; reason: string | null; before: any; after: any }[]
export const notes = async (keyPrefix: string) => (await admin().query(`SELECT dedupe_key, kind, to_staff_id, to_role, site_id, text FROM notification WHERE dedupe_key LIKE $1 ORDER BY dedupe_key`, [keyPrefix + '%'])).rows as { dedupe_key: string; kind: string; to_staff_id: string | null; to_role: string | null; site_id: string | null; text: string }[]
export const reservationsOf = async (staffId: string) => (await admin().query(`SELECT * FROM reservation WHERE staff_id = $1`, [staffId])).rows as { id: string; bed_id: string; claim_id: string; status: string; source: string; stay_type: string; eta: Date; request_id: string | null; created_by: string | null }[]
export const reservationCount = async (staffId: string) => (await reservationsOf(staffId)).length
