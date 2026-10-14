import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { userAccount } from '@/server/db/schema'
import { waitlistEntry, waitlistPriorityRequest } from '@/server/db/schema.waitlist'
import { audit } from '@/server/audit'
import { authorize, notSelf } from '@/server/command/authorize'
import { runCommand } from '@/server/command/run'
import type { RequestContext } from '@/server/command/context'
import { fail, ok, type Result } from '@/server/command/result'
import { approvalClock } from '@/domain/approvals'
import { getConfig } from '@/server/config/registry'
import { loadCalendar } from '@/server/eligibility'
import { notify } from '@/server/notify'
import { decide } from '@/server/policy'
import { queuePosition } from './queue'
import { idSchema, loadEntry, reasonSchema, staffName } from './shared'

export const requestInput = z.object({
  entryId: idSchema,
  category: z.string().trim().min(1, 'Choose a category').max(60),
  reason: reasonSchema,
  evidence: z.string().trim().min(3, 'Evidence is required (what supports this, at least 3 characters)').max(1000),
})
export type RequestPriorityInput = z.infer<typeof requestInput>

/**
 * An Accommodation Admin asks for a queue priority category for someone (D-53, APPROVALS.md "Waitlist priority exception").
 * The category must be one of the approved list (GH-04 is OPEN: the list is empty until Grand Hyatt supplies it, so nothing
 * can be asked for until an administrator configures it). Reason and evidence are mandatory. A Policy Approver decides.
 */
export function requestPriority(rc: RequestContext, i: RequestPriorityInput): Promise<Result<{ priorityRequestId: string }>> {
  return runCommand(rc, async c => {
    const peek = await loadEntry(c.tx, i.entryId)
    if (!peek) return fail.notFound()
    const denied = authorize(c, 'requests_waitlist.manage_waitlist', { siteId: peek.siteId })
    if (denied) return denied
    const sod = notSelf(c, peek.staffId, 'ask for priority')
    if (sod) return sod

    const cats = await getConfig(c.tx, 'eligibility.priority_categories')
    if (cats.length === 0) {
      return fail.conflict('No waitlist priority categories are defined yet (open question GH-04)', 'Super Admin', 'Grand Hyatt must name the approved categories; a Super Admin then adds them in Configuration', { reason: 'no_categories' })
    }
    if (!cats.includes(i.category)) return fail.invalid('That is not an approved priority category', { category: `Choose one of: ${cats.join(', ')}` })

    const e = await loadEntry(c.tx, i.entryId, true)
    if (!e || e.status === 'closed') return fail.conflict('This entry is closed', 'Accommodation Admin', 'Priority applies to people still waiting', { reason: 'entry_closed' })
    if (e.priority === i.category) return fail.conflict(`This entry already has the priority "${i.category}"`, 'Accommodation Admin', 'Nothing to change')
    const [pending] = await c.tx.select({ id: waitlistPriorityRequest.id }).from(waitlistPriorityRequest).where(and(eq(waitlistPriorityRequest.entryId, e.id), eq(waitlistPriorityRequest.status, 'pending'))).limit(1)
    if (pending) return fail.conflict('A priority request for this entry is already waiting for a Policy Approver', 'Policy Approver', 'Wait for the decision', { reason: 'already_pending', priorityRequestId: pending.id })

    const [row] = await c.tx.insert(waitlistPriorityRequest).values({
      entryId: e.id, staffId: e.staffId, siteId: e.siteId, category: i.category, reason: i.reason, evidence: i.evidence, requestedBy: c.user.id, createdAt: c.now,
    }).returning({ id: waitlistPriorityRequest.id })
    await audit(c, { action: 'waitlist.priority.requested', entityType: 'waitlist_priority_request', entityId: row.id, siteId: e.siteId, reason: i.reason, after: { entryId: e.id, category: i.category, evidence: i.evidence, currentPriority: e.priority } })
    await notify(c.tx, {
      dedupeKey: `waitlist:priority:${row.id}:requested`, kind: 'waitlist.priority_requested', to: { role: 'PolicyApprover', siteId: e.siteId },
      text: `Priority "${i.category}" requested for ${await staffName(c.tx, e.staffId)} on the waitlist: ${i.reason}`, ref: { type: 'waitlist_priority_request', id: row.id },
    })
    return ok({ priorityRequestId: row.id }, 'Sent to a Policy Approver')
  })
}

export const decideInput = z.object({
  priorityRequestId: idSchema,
  decision: z.enum(['approve', 'reject']),
  note: z.string().trim().max(500).optional(),
})
export type DecidePriorityInput = z.infer<typeof decideInput>

/**
 * The Policy Approver decides (reason mandatory when rejecting). Never the person concerned and never the one who asked (D-26).
 * A named Backup Approver may decide once the item is routed to them (one business day past the SLA), never earlier. Approving sets
 * the entry's priority; the queue position before and after is recorded on the request and in the audit (queue history).
 */
export function decidePriority(rc: RequestContext, i: DecidePriorityInput): Promise<Result<{ positionBefore: number; positionAfter: number }>> {
  return runCommand(rc, async c => {
    const [peek] = await c.tx.select().from(waitlistPriorityRequest).where(eq(waitlistPriorityRequest.id, i.priorityRequestId)).limit(1)
    if (!peek) return fail.notFound()
    const res = { siteId: peek.siteId }
    const primary = decide(c.actor, 'requests_waitlist.approve_exception', res)
    if (!primary.allowed) {
      const backup = decide(c.actor, 'approvals_inbox.decide_escalated', res)
      if (!backup.allowed) return authorize(c, 'requests_waitlist.approve_exception', res)!
      const clock = approvalClock(peek.createdAt.getTime(), c.now.getTime(), await getConfig(c.tx, 'timers.routine_sla_business_days'), await loadCalendar(c.tx, peek.siteId))
      if (clock.level < 1) return fail.conflict('This is still with the Policy Approver', 'Policy Approver', 'You can decide it if it is routed to you as the backup (after the first SLA period)', { reason: 'not_yet_routed' })
    }
    const sod = notSelf(c, peek.staffId, 'decide priority')
    if (sod) return sod
    if (peek.requestedBy === c.user.id) return fail.sod('You raised this priority request, so you cannot decide it')

    const e = await loadEntry(c.tx, peek.entryId, true)
    const [r] = await c.tx.select().from(waitlistPriorityRequest).where(eq(waitlistPriorityRequest.id, peek.id)).limit(1).for('update')
    if (!e || !r) return fail.notFound()
    if (r.status !== 'pending') return fail.conflict(`This priority request is already ${r.status}`, 'Policy Approver', 'Nothing more to do', { reason: 'already_decided' })
    if (e.status === 'closed') return fail.conflict('The waitlist entry is closed', 'Accommodation Admin', 'Nothing to decide', { reason: 'entry_closed' })
    if (i.decision === 'reject' && !i.note) return fail.invalid('Say why you are rejecting it', { note: 'Required when rejecting' })

    const before = (await queuePosition(c.tx, e.siteId, e.id)) ?? 0
    if (i.decision === 'approve') await c.tx.update(waitlistEntry).set({ priority: r.category }).where(eq(waitlistEntry.id, e.id))
    const after = (await queuePosition(c.tx, e.siteId, e.id)) ?? 0
    await c.tx.update(waitlistPriorityRequest).set({
      status: i.decision === 'approve' ? 'approved' : 'rejected', decidedBy: c.user.id, decidedAt: c.now, decisionNote: i.note ?? null, positionBefore: before, positionAfter: after,
    }).where(eq(waitlistPriorityRequest.id, r.id))
    await audit(c, {
      action: i.decision === 'approve' ? 'waitlist.priority.approved' : 'waitlist.priority.rejected', entityType: 'waitlist_priority_request', entityId: r.id, siteId: e.siteId, reason: i.note,
      before: { priority: e.priority, priorSequence: before }, after: { priority: i.decision === 'approve' ? r.category : e.priority, newSequence: after, entryId: e.id, category: r.category },
    })
    const [asker] = await c.tx.select({ staffId: userAccount.staffId }).from(userAccount).where(eq(userAccount.id, r.requestedBy)).limit(1)
    const verdict = i.decision === 'approve' ? `approved: "${r.category}" priority, position ${before} to ${after}` : `rejected${i.note ? ` (${i.note})` : ''}`
    await notify(c.tx, { dedupeKey: `waitlist:priority:${r.id}:decided:admin`, kind: 'waitlist.priority_decided', to: asker?.staffId ? { staffId: asker.staffId } : { role: 'AA', siteId: e.siteId }, text: `Priority request for ${await staffName(c.tx, e.staffId)} ${verdict}`, ref: { type: 'waitlist_priority_request', id: r.id } })
    if (i.decision === 'approve') {
      await notify(c.tx, { dedupeKey: `waitlist:priority:${r.id}:decided:resident`, kind: 'waitlist.priority_decided', to: { staffId: e.staffId }, text: `Your waitlist priority was approved. You are now number ${after} in the queue.`, ref: { type: 'waitlist_entry', id: e.id } })
    }
    return ok({ positionBefore: before, positionAfter: after }, i.decision === 'approve' ? `Approved. Position ${before} to ${after}` : 'Rejected')
  })
}
