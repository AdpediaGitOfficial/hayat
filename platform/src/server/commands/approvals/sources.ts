/**
 * WP-D approval sources for the inbox (docs/APPROVALS.md, STAGE-2 section 2):
 *   request    a submitted request waiting for an Accommodation Admin to pick a bed (backup: Policy Approver; then Super Admin)
 *   exception  a request in pending_approval waiting for a Policy Approver's gender/grade decision
 * Reading only: the inbox, the reminder sweep and the delegation reminders all call listPending(). Nothing here decides.
 */
import { and, eq } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { accommodationRequest, site, staffProfile, userAccount } from '@/server/db/schema'
import { requestExceptionAsk } from '@/server/db/schema.requests'
import { registerApprovalSource } from '@/server/approvals/registry'
import type { ApprovalDraft, ApprovalSource, Decider } from '@/server/approvals/types'
import { getConfig } from '@/server/config/registry'
import { isUrgent } from '@/domain/approvals'
import { fmtDate } from '@/domain/time'

export const REQUEST_DECIDERS: Decider[] = [
  { level: 0, label: 'Accommodation Admin', action: 'requests_waitlist.approve', notify: 'AA' },
  { level: 1, label: 'Policy Approver', action: 'requests_waitlist.approve_exception', notify: 'PolicyApprover' },
  { level: 2, label: 'Super Admin', action: 'requests_waitlist.approve_exception', notify: 'SA' },
]
// A Super Admin does not decide gender or grade exceptions (D-25): they are told when it escalates, and the Policy Approver keeps the decision.
export const EXCEPTION_DECIDERS: Decider[] = [
  { level: 0, label: 'Policy Approver', action: 'requests_waitlist.approve_exception', notify: 'PolicyApprover' },
  { level: 1, label: 'Named backup approver', action: 'requests_waitlist.approve_exception', notify: 'PolicyApprover' },
  { level: 2, label: 'Super Admin', action: 'requests_waitlist.approve_exception', notify: 'SA' },
]

const submitter = alias(userAccount, 'submitter')
const window = (arrival: string, end: string | null) => `${fmtDate(arrival)} to ${end ? fmtDate(end) : 'open-ended'}`

const requestSource: ApprovalSource = {
  kind: 'request',
  async listPending(db, now) {
    const sla = await getConfig(db, 'timers.routine_sla_business_days')
    const rows = await db.select({
      id: accommodationRequest.id, siteId: accommodationRequest.siteId, staffId: accommodationRequest.staffId, name: staffProfile.fullName, employeeId: staffProfile.employeeId,
      stayType: accommodationRequest.stayType, arrival: accommodationRequest.arrivalDate, end: accommodationRequest.endDate, since: accommodationRequest.updatedAt,
      onBehalf: accommodationRequest.onBehalf, submitterStaffId: submitter.staffId, siteName: site.name,
    }).from(accommodationRequest)
      .innerJoin(staffProfile, eq(staffProfile.id, accommodationRequest.staffId))
      .innerJoin(site, eq(site.id, accommodationRequest.siteId))
      .leftJoin(submitter, eq(submitter.id, accommodationRequest.submittedBy))
      .where(eq(accommodationRequest.status, 'submitted'))
    return rows.map((r): ApprovalDraft => ({
      kind: 'request', ref: r.id, siteId: r.siteId, subjectStaffIds: [r.staffId],
      raisedByStaffId: (r.onBehalf ? r.submitterStaffId : r.staffId) ?? undefined,
      title: `${r.name} (${r.employeeId}): bed request, ${r.stayType}`,
      sub: `${r.siteName} · ${window(r.arrival, r.end)}`,
      // The clock runs from when the request reached the admin: filing, or the last resubmission or exception decision.
      createdAt: r.since.getTime(),
      deciders: REQUEST_DECIDERS, urgent: isUrgent(r.arrival, now.getTime(), sla), href: `/requests/${r.id}`,
    }))
  },
}

const exceptionSource: ApprovalSource = {
  kind: 'exception',
  async listPending(db) {
    const rows = await db.select({
      id: accommodationRequest.id, siteId: accommodationRequest.siteId, staffId: accommodationRequest.staffId, name: staffProfile.fullName, employeeId: staffProfile.employeeId,
      arrival: accommodationRequest.arrivalDate, end: accommodationRequest.endDate, onBehalf: accommodationRequest.onBehalf, submitterStaffId: submitter.staffId,
      kinds: requestExceptionAsk.kinds, reason: requestExceptionAsk.reason, askedAt: requestExceptionAsk.createdAt, siteName: site.name,
    }).from(accommodationRequest)
      .innerJoin(requestExceptionAsk, and(eq(requestExceptionAsk.requestId, accommodationRequest.id), eq(requestExceptionAsk.status, 'asked')))
      .innerJoin(staffProfile, eq(staffProfile.id, accommodationRequest.staffId))
      .innerJoin(site, eq(site.id, accommodationRequest.siteId))
      .leftJoin(submitter, eq(submitter.id, accommodationRequest.submittedBy))
      .where(eq(accommodationRequest.status, 'pending_approval'))
    return rows.map((r): ApprovalDraft => ({
      kind: 'exception', ref: r.id, siteId: r.siteId, subjectStaffIds: [r.staffId],
      raisedByStaffId: (r.onBehalf ? r.submitterStaffId : r.staffId) ?? undefined,
      title: `${r.name} (${r.employeeId}): ${r.kinds.join(' and ')} exception`,
      sub: `${r.siteName} · ${window(r.arrival, r.end)} · ${r.reason}`,
      createdAt: r.askedAt.getTime(), deciders: EXCEPTION_DECIDERS, href: `/requests/${r.id}`,
    }))
  },
}

registerApprovalSource(requestSource)
registerApprovalSource(exceptionSource)
