import { and, eq } from 'drizzle-orm'
import { auditEvent, staffProfile } from '@/server/db/schema'
import { emergencyCheckin } from '@/server/db/schema.emergency'
import type { Tx } from '@/server/command/context'
import { notify } from '@/server/notify'
import { primaryRecipient } from './shared'

export interface ConvertedCase { caseId: string; stayId: string; siteId: string }
export interface ConvertContext { now: Date; userId?: string | null; role?: string; requestId?: string }

/**
 * D-36: when a person is marked as Left, any emergency approval still pending for them is CONVERTED into the clearance case.
 * Stage 3's Mark as Left calls this inside its own transaction, with the clearance case it has just opened.
 *
 * It closes the approval question (nobody needs to approve a stay that is ending: status 'converted', reminders stop) and
 * writes the audit row and a note to the approver. It does NOT touch the stay or the bed: Mark as Left revokes the login at
 * once, but the bed is not freed until the actual checkout, and a provisional stay can only be checked out by a person.
 */
export async function convertEmergencyForExit(tx: Tx, staffId: string, ctx: ConvertContext, o: { clearanceCaseId?: string } = {}): Promise<ConvertedCase[]> {
  const rows = await tx.select().from(emergencyCheckin)
    .where(and(eq(emergencyCheckin.staffId, staffId), eq(emergencyCheckin.status, 'pending'))).for('update')
  const out: ConvertedCase[] = []
  for (const k of rows) {
    const note = o.clearanceCaseId
      ? `Person marked as Left; the pending approval became part of clearance case ${o.clearanceCaseId} (D-36)`
      : 'Person marked as Left; the pending approval became part of the clearance case (D-36)'
    await tx.update(emergencyCheckin).set({ status: 'converted', convertedAt: ctx.now, conversionNote: note }).where(eq(emergencyCheckin.id, k.id))
    await tx.insert(auditEvent).values({
      actorUserId: ctx.userId ?? null, actorRole: ctx.role ?? 'system', action: 'emergency.converted_for_exit', entityType: 'emergency_checkin', entityId: k.id, siteId: k.siteId,
      reason: note, before: { status: 'pending', reminders: k.reminders, escalation: k.escalation }, after: { status: 'converted', stayId: k.stayId, stayChanged: false, bedFreed: false },
      requestId: ctx.requestId ?? null,
    })
    const [p] = await tx.select({ name: staffProfile.fullName, employeeId: staffProfile.employeeId }).from(staffProfile).where(eq(staffProfile.id, staffId)).limit(1)
    await notify(tx, {
      dedupeKey: `emergency:${k.id}:converted`, kind: 'emergency.converted', to: { role: primaryRecipient(k.approverRoute), siteId: k.siteId },
      text: `${p?.name ?? 'The resident'} (${p?.employeeId ?? ''}) was marked as Left. The pending emergency check-in no longer needs a decision; it continues in the clearance case.`,
      ref: { type: 'emergency_checkin', id: k.id },
    })
    out.push({ caseId: k.id, stayId: k.stayId, siteId: k.siteId })
  }
  return out
}
