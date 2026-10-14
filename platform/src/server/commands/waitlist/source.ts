/**
 * Approval source for the Approvals inbox (STAGE-2 section 2): a waitlist priority request is a pending decision of the
 * Policy Approver (primary), then the named backup, with the generic SLA clock and reminders. Importing this file registers it.
 *
 * Waitlist renewal is NOT an approval source: it is a direct action of the Accommodation Admin (see renewEntry), who is reminded
 * by the waitlist sweep at 3 and 1 days before expiry.
 */
import { and, eq } from 'drizzle-orm'
import { staffProfile, userAccount } from '@/server/db/schema'
import { waitlistPriorityRequest } from '@/server/db/schema.waitlist'
import { registerApprovalSource } from '@/server/approvals/registry'
import type { ApprovalDraft } from '@/server/approvals/types'

registerApprovalSource({
  kind: 'waitlist_priority',
  async listPending(db): Promise<ApprovalDraft[]> {
    const rows = await db.select({
      id: waitlistPriorityRequest.id, siteId: waitlistPriorityRequest.siteId, staffId: waitlistPriorityRequest.staffId, category: waitlistPriorityRequest.category,
      reason: waitlistPriorityRequest.reason, createdAt: waitlistPriorityRequest.createdAt, name: staffProfile.fullName, askerStaffId: userAccount.staffId,
    }).from(waitlistPriorityRequest)
      .innerJoin(staffProfile, eq(staffProfile.id, waitlistPriorityRequest.staffId))
      .innerJoin(userAccount, eq(userAccount.id, waitlistPriorityRequest.requestedBy))
      .where(and(eq(waitlistPriorityRequest.status, 'pending')))
    return rows.map(r => ({
      kind: 'waitlist_priority', ref: r.id, siteId: r.siteId, subjectStaffIds: [r.staffId], raisedByStaffId: r.askerStaffId ?? undefined,
      title: `Waitlist priority: ${r.name}`, sub: `${r.category}. ${r.reason}`, createdAt: r.createdAt.getTime(), href: '/waitlist',
      deciders: [
        { level: 0 as const, label: 'Policy Approver', action: 'requests_waitlist.approve_exception' as const, notify: 'PolicyApprover' as const },
        { level: 1 as const, label: 'Named backup approver', action: 'approvals_inbox.decide_escalated' as const, notify: 'BackupApprover' as const },
        { level: 2 as const, label: 'Policy Approver (escalated)', action: 'requests_waitlist.approve_exception' as const, notify: 'PolicyApprover' as const },
      ],
    }))
  },
})
