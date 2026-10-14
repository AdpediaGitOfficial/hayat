/**
 * Emergency check-ins in the approvals inbox. The clock is the hours-based emergency clock (24 h deadline, re-alert every
 * 24 h, escalate after two unanswered), not business days, so the item carries `ownClock` and the generic business-day
 * reminder sweep skips it: the emergency sweep (jobs/sweeps/emergency.ts) reminds and escalates. Reading this never changes anything.
 *
 * The inbox decides "can this viewer act" from the policy ACTION per level, which cannot tell a Backup Approver from a Policy
 * Approver; the real route check (`standing()` in commands/emergency/rules.ts) runs in the command and on the case screen.
 */
import { and, eq } from 'drizzle-orm'
import { bed, staffProfile, stay } from '@/server/db/schema'
import { emergencyCheckin } from '@/server/db/schema.emergency'
import { registerApprovalSource } from '@/server/approvals/registry'
import type { ApprovalDraft, Decider } from '@/server/approvals/types'
import type { ApprovalClock } from '@/domain/approvals'
import { LEVEL_LABEL, primaryLabel, standing } from '@/server/commands/emergency/rules'

function deciders(route: 'AA' | 'PA'): Decider[] {
  const primary: Decider = route === 'AA'
    ? { level: 0, label: primaryLabel('AA'), action: 'approvals_inbox.decide_route', notify: 'AA' }
    : { level: 0, label: primaryLabel('PA'), action: 'approvals_inbox.decide_escalated', notify: 'PolicyApprover' }
  return [
    primary,
    { level: 1, label: LEVEL_LABEL[1], action: 'approvals_inbox.decide_escalated', notify: 'BackupApprover' },
    { level: 2, label: LEVEL_LABEL[2], action: 'approvals_inbox.decide_escalated', notify: 'PolicyApprover' },
  ]
}

export function emergencyClock(k: { reminders: number; escalation: number }, createdMs: number, nowMs: number): ApprovalClock {
  const level = Math.min(Math.max(k.escalation, 0), 2) as 0 | 1 | 2
  return {
    businessDays: Math.floor((nowMs - createdMs) / 86_400_000), // whole days waiting, 24/7; the field name is the generic clock's
    reminders: k.reminders, level,
    label: level === 2 ? 'Escalated' : level === 1 ? 'Routed to backup' : k.reminders ? 'Reminded' : 'Within SLA',
  }
}

registerApprovalSource({
  kind: 'emergency',
  async listPending(db, now) {
    const rows = await db.select({
      id: emergencyCheckin.id, siteId: emergencyCheckin.siteId, staffId: emergencyCheckin.staffId, route: emergencyCheckin.approverRoute,
      initiatedBy: emergencyCheckin.initiatedBy, initiatedByStaffId: emergencyCheckin.initiatedByStaffId, reason: emergencyCheckin.reason, createdAt: emergencyCheckin.createdAt,
      reminders: emergencyCheckin.reminders, escalation: emergencyCheckin.escalation, name: staffProfile.fullName, bedCode: bed.code,
    }).from(emergencyCheckin)
      .innerJoin(stay, eq(stay.id, emergencyCheckin.stayId))
      .innerJoin(staffProfile, eq(staffProfile.id, emergencyCheckin.staffId))
      .innerJoin(bed, eq(bed.id, emergencyCheckin.bedId))
      .where(and(eq(emergencyCheckin.status, 'pending'), eq(stay.status, 'provisional')))
    return rows.map((r): ApprovalDraft => ({
      kind: 'emergency', ref: r.id, siteId: r.siteId, subjectStaffIds: [r.staffId], raisedByStaffId: r.initiatedByStaffId ?? undefined,
      title: `Emergency check-in: ${r.name} in ${r.bedCode}`, sub: r.reason, createdAt: r.createdAt.getTime(), urgent: true, href: `/emergency/${r.id}`,
      deciders: deciders(r.route), ownClock: emergencyClock(r, r.createdAt.getTime(), now.getTime()),
      // Exactly the rule the approve and reject commands apply (route and escalation level decide between the Accommodation Admin, the Backup
      // Approver and the Policy Approver; D-66 to D-68, D-107). Emergency backup is not proposed policy P-01: it is decided.
      decidable: (actor, ctx) => standing({ actor, userId: ctx.userId ?? '' }, {
        route: r.route, escalation: r.escalation, siteId: r.siteId, initiatedBy: r.initiatedBy, initiatedByStaffId: r.initiatedByStaffId, subjectStaffId: r.staffId,
      }).ok,
    }))
  },
})
