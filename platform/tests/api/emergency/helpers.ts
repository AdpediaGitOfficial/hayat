/**
 * Arrangement for the emergency tests. People are real accounts (created with the superuser pool, signed in through the real
 * login), commands are called with a RequestContext on a FixedClock (so 24 h and 48 h boundaries are exact), routes are called with
 * the real handlers. Every test builds its own site, so files can run in parallel against one database.
 */
import { admin, grantCapability, makeUser, signIn, type TestUser } from '../harness'
import { FixedClock } from '@/server/clock'
import { getDb } from '@/server/db/client'
import type { RequestContext } from '@/server/command/context'
import type { SweepContext } from '@/server/jobs/registry'
import type { Capability, Role } from '@/domain/enums'
import { rcFor } from '../rc'
import { mkProperty, mkStaff } from '../fixtures2'
import { initiateEmergency, type InitiateOut } from '@/server/commands/emergency/initiate'
import type { Result } from '@/server/command/result'

export const T0 = new Date('2026-10-14T09:00:00Z')
export const HOUR = 3_600_000

export interface Who {
  user: TestUser
  role: Role
  caps: Capability[]
  cookie: string
  rc: (clock: FixedClock) => RequestContext
}

export async function who(role: Role, o: { siteIds?: string[]; caps?: Capability[] } = {}): Promise<Who> {
  const caps = o.caps ?? []
  const roles = role === 'SA' ? [{ role, all: true }] : role === 'Res' ? [{ role }] : (o.siteIds ?? []).map(siteId => ({ role, siteId }))
  const user = await makeUser({ roles })
  for (const c of caps) await grantCapability(user.id, c)
  return {
    user, role, caps, cookie: await signIn(user),
    rc: clock => rcFor(user.id, { role, caps, sites: role === 'SA' ? 'all' : o.siteIds ?? [], staffId: user.staffId }, clock),
  }
}

/** One site with beds, a Reception initiator, an AA initiator, an independent AA, a Policy Approver, a Backup Approver and a Super Admin. */
export async function world(beds = 6) {
  const p = await mkProperty({ beds })
  const rec = await who('Rec', { siteIds: [p.siteId], caps: ['EmergencyCheckin'] })
  const aaInit = await who('AA', { siteIds: [p.siteId], caps: ['EmergencyCheckin'] })
  const aa = await who('AA', { siteIds: [p.siteId] })
  const pa = await who('Mgr', { siteIds: [p.siteId], caps: ['PolicyApprover'] })
  const backup = await who('Mgr', { siteIds: [p.siteId], caps: ['BackupApprover'] })
  const sa = await who('SA')
  return { ...p, rec, aaInit, aa, pa, backup, sa }
}
export type World = Awaited<ReturnType<typeof world>>

export const clockAt = (offsetHours = 0) => new FixedClock(new Date(T0.getTime() + offsetHours * HOUR))

/** Reception (or the given initiator) starts an emergency check-in for a fresh staff member in bed `bedIndex`. */
export async function start(w: World, o: { by?: Who; bedIndex?: number; clock?: FixedClock; staffId?: string; reason?: string } = {}) {
  const by = o.by ?? w.rec
  const staffId = o.staffId ?? (await mkStaff()).id
  const clock = o.clock ?? clockAt(0)
  const r: Result<InitiateOut> = await initiateEmergency(by.rc(clock), { staffId, bedId: w.bedIds[o.bedIndex ?? 0], reason: o.reason ?? 'Fire alarm in block D, relocated overnight' })
  if (!r.ok) throw new Error(`initiate failed: ${r.reason}`)
  return { ...r.data, staffId, clock }
}

export function sweepCtx(clock: FixedClock): SweepContext {
  return { clock, now: clock.now(), db: getDb(), requestId: 'test-sweep' }
}

export async function caseRow(id: string) {
  return (await admin().query(`SELECT * FROM emergency_checkin WHERE id = $1`, [id])).rows[0]
}
export async function stayRow(id: string) {
  return (await admin().query(`SELECT * FROM stay WHERE id = $1`, [id])).rows[0]
}
export async function bedState(id: string) {
  return (await admin().query<{ state: string }>(`SELECT state FROM bed WHERE id = $1`, [id])).rows[0].state
}
export async function claimOf(stayId: string) {
  return (await admin().query(`SELECT c.* FROM bed_claim c JOIN stay s ON s.claim_id = c.id WHERE s.id = $1`, [stayId])).rows[0]
}
export async function notifs(caseId: string) {
  return (await admin().query<{ dedupe_key: string; kind: string; to_role: string | null; to_staff_id: string | null; critical: boolean; text: string }>(
    `SELECT dedupe_key, kind, to_role, to_staff_id, critical, text FROM notification WHERE dedupe_key LIKE $1 ORDER BY created_at, dedupe_key`, [`emergency:${caseId}:%`])).rows
}
export async function auditFor(entityId: string) {
  return (await admin().query<{ action: string; actor_user_id: string | null; actor_role: string | null; reason: string | null; before: any; after: any }>(
    `SELECT action, actor_user_id, actor_role, reason, before, after FROM audit_event WHERE entity_id = $1 ORDER BY seq`, [entityId])).rows
}
export async function taskFor(caseId: string) {
  return (await admin().query(`SELECT * FROM task WHERE ref_type = 'emergency_checkin' AND ref_id = $1`, [caseId])).rows
}
/** What a person would do through the stay screens (WP-F): check the resident out. The tests use SQL because WP-F's commands are not part of this package. */
export async function checkOutByHand(stayId: string) {
  await admin().query(`UPDATE stay SET status = 'checked_out', checked_out_at = now() WHERE id = $1`, [stayId])
}
