/**
 * Emergency check-in sweeps (D-66 to D-69, AT-015, AT-016). Hours-based clock, 24/7.
 *
 *  emergency_reminders: a pending case past its decision deadline (24 h) gets a reminder to the approver, then a re-alert every
 *    24 h. After two unanswered reminders it escalates: level 1 to the authorised backup (BackupApprover holders; if nobody holds
 *    that capability for the site, to the Policy Approvers so the escalation is never lost), level 2 (critical) to the Policy
 *    Approvers and the Super Admins. It NEVER approves, rejects, moves or checks anyone out: the stay stays Provisional until a
 *    person decides. The approval source (queries/emergency/approvalSource.ts) carries `ownClock`, so the generic business-day
 *    sweep skips these items.
 *  emergency_relocation_overdue: an open relocation or checkout task past its deadline reminds the owner (AA) and alerts the
 *    Policy Approver (APPROVALS.md "Emergency rejection follow-up"). It never moves the resident.
 *
 * Idempotent and safe to run concurrently: each case is handled in its own transaction under a row lock with the status
 * re-checked, and every notification has a dedupe key built from the case and the reminder or level (not from the clock).
 */
import { and, eq, gt, inArray, isNull, lte, or } from 'drizzle-orm'
import { bed, capabilityGrant, roleAssignment, staffProfile, stay, userAccount } from '@/server/db/schema'
import { emergencyCheckin, task } from '@/server/db/schema.emergency'
import { auditSystem, registerSweep, systemTx, type SweepContext } from '@/server/jobs/registry'
import { notify } from '@/server/notify'
import type { Tx } from '@/server/command/context'
import type { Capability } from '@/domain/enums'
import { dueReminders, escalationFor, reminderDueAt } from '@/server/commands/emergency/rules'
import { loadTiming, primaryRecipient } from '@/server/commands/emergency/shared'

/** Does someone hold this capability, actively, with a role assignment that covers the site? */
async function hasHolder(tx: Tx, cap: Capability, siteId: string, now: Date): Promise<boolean> {
  const [r] = await tx.select({ id: capabilityGrant.id }).from(capabilityGrant)
    .innerJoin(userAccount, and(eq(userAccount.id, capabilityGrant.userId), eq(userAccount.status, 'active')))
    .innerJoin(roleAssignment, and(eq(roleAssignment.userId, userAccount.id), isNull(roleAssignment.revokedAt), or(eq(roleAssignment.scopeKind, 'all'), eq(roleAssignment.siteId, siteId))))
    .where(and(eq(capabilityGrant.capability, cap), eq(capabilityGrant.status, 'active'), isNull(capabilityGrant.revokedAt), lte(capabilityGrant.startsAt, now),
      or(isNull(capabilityGrant.expiresAt), gt(capabilityGrant.expiresAt, now)))).limit(1)
  return !!r
}

const ago = (ms: number) => { const h = Math.floor(ms / 3_600_000); return h >= 48 ? `${Math.floor(h / 24)} days` : `${h} hours` }

/** The reminder and escalation pass. `only` limits it to some cases (tests, one-off repair); the registered sweep always runs on all. */
export async function emergencyReminders(ctx: SweepContext, only?: string[]) {
  const out = { checked: 0, reminded: 0, escalated: 0, failed: 0 }
  const now = ctx.now
  const candidates = await ctx.db.select({ id: emergencyCheckin.id }).from(emergencyCheckin)
    .where(and(eq(emergencyCheckin.status, 'pending'), lte(emergencyCheckin.deadlineAt, now), only ? inArray(emergencyCheckin.id, only) : undefined))
  for (const cand of candidates) {
    out.checked++
    try {
      await systemTx(ctx, async tx => {
        const [row] = await tx.select({
          k: emergencyCheckin, stayStatus: stay.status, name: staffProfile.fullName, employeeId: staffProfile.employeeId, bedCode: bed.code,
        }).from(emergencyCheckin)
          .innerJoin(stay, eq(stay.id, emergencyCheckin.stayId))
          .innerJoin(staffProfile, eq(staffProfile.id, emergencyCheckin.staffId))
          .innerJoin(bed, eq(bed.id, emergencyCheckin.bedId))
          .where(eq(emergencyCheckin.id, cand.id)).limit(1).for('update', { of: emergencyCheckin })
        // Re-check under the lock: a person may have decided, or the person may have left, since the candidate list was read.
        if (!row || row.k.status !== 'pending' || row.stayStatus !== 'provisional') return
        const k = row.k
        const timing = await loadTiming(tx)
        const due = dueReminders(k.deadlineAt.getTime(), now.getTime(), timing)
        let reminders = k.reminders
        let escalation = k.escalation
        const who = `${row.name} (${row.employeeId}) in ${row.bedCode}`
        for (let n = reminders + 1; n <= due; n++) {
          const waited = reminderDueAt(k.deadlineAt.getTime(), n, timing) - k.createdAt.getTime()
          await notify(tx, {
            dedupeKey: `emergency:${k.id}:reminder${n}`, kind: 'emergency.reminder', to: { role: primaryRecipient(k.approverRoute), siteId: k.siteId }, critical: true,
            text: `Reminder ${n}: the emergency check-in of ${who} still needs a decision (waiting ${ago(waited)}). The stay stays provisional until a person decides.`,
            ref: { type: 'emergency_checkin', id: k.id },
          })
          reminders = n
          out.reminded++
          await auditSystem(tx, ctx, { action: 'emergency.reminder', entityType: 'emergency_checkin', entityId: k.id, siteId: k.siteId, before: { reminders: n - 1, escalation }, after: { reminders: n, dueAt: new Date(reminderDueAt(k.deadlineAt.getTime(), n, timing)).toISOString() } })

          const level = escalationFor(n, timing)
          while (escalation < level) {
            escalation++
            const backup = escalation === 1 && await hasHolder(tx, 'BackupApprover', k.siteId, now)
            const targets: { key: string; to: Parameters<typeof notify>[1]['to']; label: string }[] = escalation === 1
              ? [backup
                ? { key: 'backup', to: { role: 'BackupApprover', siteId: k.siteId }, label: 'authorised backup approver' }
                // Nobody holds the Backup Approver capability here: go straight to the Policy Approvers rather than lose the escalation (GH-07).
                : { key: 'policy', to: { role: 'PolicyApprover', siteId: k.siteId }, label: 'Policy Approver (no backup approver is assigned)' }]
              : [{ key: 'policy', to: { role: 'PolicyApprover', siteId: k.siteId }, label: 'Policy Approver' }, { key: 'sa', to: { role: 'SA', siteId: k.siteId }, label: 'Super Admin' }]
            for (const t of targets) {
              await notify(tx, {
                dedupeKey: `emergency:${k.id}:escalated${escalation}:${t.key}`, kind: 'emergency.escalated', to: t.to, critical: true,
                text: `Escalated to you as ${t.label}: the emergency check-in of ${who} has had ${n} unanswered reminders${escalation === 2 ? ' (critical)' : ''}. Nobody has been moved or checked out.`,
                ref: { type: 'emergency_checkin', id: k.id },
              })
            }
            out.escalated++
            await auditSystem(tx, ctx, { action: 'emergency.escalated', entityType: 'emergency_checkin', entityId: k.id, siteId: k.siteId, before: { escalation: escalation - 1 }, after: { escalation, reminders: n, notified: targets.map(t => t.label), stayChanged: false } })
          }
        }
        if (reminders !== k.reminders || escalation !== k.escalation) {
          await tx.update(emergencyCheckin).set({
            reminders, escalation, lastReminderAt: now, escalatedAt: escalation !== k.escalation ? now : k.escalatedAt,
          }).where(eq(emergencyCheckin.id, k.id))
        }
      })
    } catch (e) {
      out.failed++
      console.error(JSON.stringify({ level: 'error', msg: 'emergency reminder failed', caseId: cand.id, requestId: ctx.requestId, error: e instanceof Error ? e.message : String(e) }))
    }
  }
  return out
}

/** Overdue relocation tasks. `only` limits it to some tasks. */
export async function relocationOverdue(ctx: SweepContext, only?: string[]) {
  const out = { checked: 0, alerted: 0, failed: 0 }
  const now = ctx.now
  const open = await ctx.db.select({ id: task.id }).from(task)
    .where(and(eq(task.refType, 'emergency_checkin'), isNull(task.doneAt), isNull(task.archivedAt), lte(task.dueAt, now), only ? inArray(task.id, only) : undefined))
  for (const cand of open) {
    out.checked++
    try {
      await systemTx(ctx, async tx => {
        const [t] = await tx.select().from(task).where(eq(task.id, cand.id)).limit(1).for('update')
        if (!t || t.doneAt || !t.dueAt) return
        const late = ago(now.getTime() - t.dueAt.getTime())
        const a = await notify(tx, {
          dedupeKey: `task:${t.id}:overdue_owner`, kind: 'emergency.relocation_overdue', to: { role: t.ownerRole, siteId: t.siteId }, critical: true,
          text: `Overdue by ${late}: ${t.title}. Nobody is moved automatically; a person must relocate or check the resident out.`, ref: { type: 'task', id: t.id },
        })
        const b = await notify(tx, {
          dedupeKey: `task:${t.id}:overdue_policy`, kind: 'emergency.relocation_overdue', to: { role: 'PolicyApprover', siteId: t.siteId }, critical: true,
          text: `Escalated: the relocation task is ${late} overdue and still open: ${t.title}.`, ref: { type: 'task', id: t.id },
        })
        if (a || b) {
          out.alerted++
          await auditSystem(tx, ctx, { action: 'emergency.relocation_overdue', entityType: 'task', entityId: t.id, siteId: t.siteId, after: { dueAt: t.dueAt.toISOString(), residentMoved: false } })
        }
      })
    } catch (e) {
      out.failed++
      console.error(JSON.stringify({ level: 'error', msg: 'emergency task alert failed', taskId: cand.id, requestId: ctx.requestId, error: e instanceof Error ? e.message : String(e) }))
    }
  }
  return out
}

registerSweep({
  name: 'emergency_reminders',
  description: 'Reminds the approver of a pending emergency check-in after 24 h, re-alerts every 24 h and escalates after two unanswered. Never decides; nobody is moved.',
  run: ctx => emergencyReminders(ctx),
})
registerSweep({
  name: 'emergency_relocation_overdue',
  description: 'Reminds the owner and alerts the Policy Approver when a relocation or checkout task after a rejected emergency check-in is past its deadline. Never moves the resident.',
  run: ctx => relocationOverdue(ctx),
})
