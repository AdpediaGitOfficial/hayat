/** Helpers shared by the emergency commands and sweep: input blocks, the locked case loader, recipients, the refusal audit. */
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { auditEvent, bed, room, staffProfile, stay } from '@/server/db/schema'
import { emergencyCheckin, type EligibilityFlags, type EmergencyRoute } from '@/server/db/schema.emergency'
import { getDb } from '@/server/db/client'
import { getConfig } from '@/server/config/registry'
import type { RequestContext, Tx } from '@/server/command/context'
import { fail, type Result } from '@/server/command/result'
import type { Capability, Role } from '@/domain/enums'
import type { EmergencyTiming } from './rules'

export const idSchema = z.uuid('Not a valid identifier')
export const textSchema = (what: string, min = 3, max = 600) =>
  z.string().trim().min(min, `${what} (at least ${min} characters)`).max(max, `At most ${max} characters`)
export const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)

export type CaseRow = typeof emergencyCheckin.$inferSelect
export interface LoadedCase {
  c: CaseRow
  stayStatus: string
  stayClaimId: string
  bedCode: string
  bedState: string
  roomName: string
  staffName: string
  employeeId: string
}

/** The case with the lock the caller needs (default: FOR UPDATE on the case row only, so two decisions queue up). */
export async function loadCase(tx: Tx, id: string, lock: boolean): Promise<LoadedCase | undefined> {
  const q = tx.select({
    c: emergencyCheckin, stayStatus: stay.status, stayClaimId: stay.claimId, bedCode: bed.code, bedState: bed.state, roomName: room.name,
    staffName: staffProfile.fullName, employeeId: staffProfile.employeeId,
  }).from(emergencyCheckin)
    .innerJoin(stay, eq(stay.id, emergencyCheckin.stayId))
    .innerJoin(bed, eq(bed.id, emergencyCheckin.bedId))
    .innerJoin(room, eq(room.id, bed.roomId))
    .innerJoin(staffProfile, eq(staffProfile.id, emergencyCheckin.staffId))
    .where(eq(emergencyCheckin.id, id)).limit(1)
  const [row] = lock ? await q.for('update', { of: emergencyCheckin }) : await q
  return row
}

export async function loadTiming(q: Parameters<typeof getConfig>[0]): Promise<EmergencyTiming> {
  return {
    deadlineHours: await getConfig(q, 'timers.emergency_deadline_hours'),
    realertHours: await getConfig(q, 'timers.emergency_realert_hours'),
    escalateAfter: await getConfig(q, 'timers.emergency_escalate_after'),
  }
}

/** The role or capability that holds the decision at the primary level. */
export const primaryRecipient = (route: EmergencyRoute): Role | Capability => (route === 'AA' ? 'AA' : 'PolicyApprover')

export const flagsOf = (e: { ok: boolean; reasons: string[]; failed: string[]; exceptionable: boolean }): EligibilityFlags =>
  ({ ok: e.ok, reasons: e.reasons, failed: e.failed, exceptionable: e.exceptionable })

export const snapCase = (c: CaseRow, stayStatus?: string) => ({
  status: c.status, stayStatus, approverRoute: c.approverRoute, escalation: c.escalation, reminders: c.reminders,
  deadlineAt: c.deadlineAt.toISOString(), staffId: c.staffId, bedId: c.bedId, stayId: c.stayId,
})

export interface Refusal { caseId: string; siteId: string; attempted: 'approve' | 'reject'; who: 'initiator' | 'subject'; status: string }

/**
 * AT-017: the refusal itself is evidence. The refused command rolls back (including any audit row written inside it), so
 * the refusal is recorded with a small insert OUTSIDE the transaction, like `staff.view_denied`. The event is not allowed
 * to change the answer: if the insert fails the person still gets the refusal.
 */
export async function auditRefusal(rc: RequestContext, r: Refusal): Promise<void> {
  try {
    await getDb().insert(auditEvent).values({
      actorUserId: rc.user.id, actorRole: rc.actor.role, action: 'emergency.decision_refused', entityType: 'emergency_checkin', entityId: r.caseId, siteId: r.siteId,
      reason: r.who === 'initiator'
        ? `The initiator tried to ${r.attempted} their own emergency check-in (separation of duties, D-26)`
        : `The person the stay is for tried to ${r.attempted} it (separation of duties, D-26)`,
      before: { status: r.status }, after: { status: r.status, attempted: r.attempted, outcome: 'refused' },
      requestId: rc.requestId, ip: rc.ip ?? null,
    })
  } catch (e) {
    console.error(JSON.stringify({ level: 'error', msg: 'emergency.decision_refused audit failed', requestId: rc.requestId, error: e instanceof Error ? e.message : String(e) }))
  }
}

/** Direct callers (tests, other commands) get the same field-level answer a route gives for a bad body. */
export function parseInput<S extends z.ZodType>(schema: S, raw: unknown): Result<z.output<S>> {
  const r = schema.safeParse(raw)
  if (r.success) return { ok: true, data: r.data }
  const fields: Record<string, string> = {}
  for (const issue of r.error.issues) fields[issue.path.join('.') || '_'] ??= issue.message
  return fail.invalid('Some fields need attention', fields)
}
