/**
 * Plain-language wording for requests and reservations (pure; shared by pages and queries).
 * Every blocked or waiting state says what is happening, who owns the next step and what to do (D-93).
 */
import { businessDaysElapsed, type Calendar } from './approvals'
import { DAY } from './time'
import type { RequestStatus, ReservationStatus } from './enums'

/** Keys understood by the shared status chip (src/ui/status.ts). */
export const REQUEST_CHIP: Record<RequestStatus, { key: string; label: string }> = {
  draft: { key: 'Open', label: 'Draft' },
  submitted: { key: 'Submitted', label: 'Submitted' },
  pending_approval: { key: 'Pending', label: 'Waiting for exception' },
  changes_requested: { key: 'ChangesRequested', label: 'Changes requested' },
  approved: { key: 'Approved', label: 'Approved' },
  rejected: { key: 'Rejected', label: 'Rejected' },
  cancelled: { key: 'Cancelled', label: 'Cancelled' },
  waitlisted: { key: 'Waitlisted', label: 'Waitlisted' },
  closed: { key: 'Closed', label: 'Closed' },
}
export const RESERVATION_CHIP: Record<ReservationStatus, { key: string; label: string }> = {
  reserved: { key: 'Reserved', label: 'Reserved' },
  checked_in: { key: 'CheckedIn', label: 'Checked in' },
  cancelled: { key: 'Cancelled', label: 'Cancelled' },
  no_show: { key: 'No-show', label: 'No-show' },
  expired: { key: 'Expired', label: 'Expired' },
}
export const STAY_TYPE_LABEL = { permanent: 'Permanent', contract: 'Contract', trainee: 'Trainee' } as const

export interface Explained { title: string; owner: string; next: string; tone: 'info' | 'warning' | 'success' | 'danger' }

/** What the person sees about their own request: where it is, who has it, what happens next. */
export function explainRequest(r: { status: RequestStatus; decisionReason?: string | null }): Explained {
  switch (r.status) {
    case 'submitted': return { tone: 'info', title: 'Waiting for an Accommodation Admin to choose a bed', owner: 'Accommodation Admin', next: 'Nothing is needed from you. You will be notified when a bed is reserved' }
    case 'pending_approval': return { tone: 'info', title: 'Waiting for a Policy Approver to decide an exception', owner: 'Policy Approver', next: 'Nothing is needed from you. You will be notified of the outcome' }
    case 'changes_requested': return { tone: 'warning', title: `Sent back to you${r.decisionReason ? `: ${r.decisionReason}` : ''}`, owner: 'You', next: 'Edit the request and send it back' }
    case 'approved': return { tone: 'success', title: 'Approved: a bed is reserved for you', owner: 'Reception', next: 'Go to Reception on your arrival date to be checked in' }
    case 'rejected': return { tone: 'danger', title: `Not approved${r.decisionReason ? `: ${r.decisionReason}` : ''}`, owner: 'You', next: 'File a new request if you still need a bed' }
    case 'cancelled': return { tone: 'info', title: `Cancelled${r.decisionReason ? `: ${r.decisionReason}` : ''}`, owner: 'You', next: 'File a new request if you still need a bed' }
    case 'waitlisted': return { tone: 'info', title: 'On the waitlist: no suitable bed is free yet', owner: 'Accommodation Admin', next: 'You will get a bed offer when one is free. You then have 48 hours to answer' }
    default: return { tone: 'info', title: r.status.replace(/_/g, ' '), owner: 'Accommodation Admin', next: 'Open the request for details' }
  }
}

/** Timeline wording for audit actions on a request. `private` events (exceptions) are for staff only, never the resident. */
export const REQUEST_EVENT: Record<string, { label: string; private?: boolean }> = {
  'requests.request.submitted': { label: 'Request submitted' },
  'requests.request.edited': { label: 'Request edited' },
  'requests.request.resubmitted': { label: 'Sent back to the Accommodation Admin' },
  'requests.request.changes_requested': { label: 'Sent back for changes' },
  'requests.request.rejected': { label: 'Rejected' },
  'requests.request.cancelled': { label: 'Cancelled' },
  'requests.request.approved': { label: 'Approved and bed reserved' },
  'requests.exception.requested': { label: 'Exception requested from a Policy Approver', private: true },
  'requests.exception.granted': { label: 'Exception granted', private: true },
  'requests.exception.declined': { label: 'Exception declined', private: true },
}

/**
 * The next step of the approval clock: the reminder at 1 business day, routing to the backup at the SLA, escalation one day later.
 * Describes only; nothing happens to the request when it passes (it only reminds and escalates).
 */
export function nextMilestone(createdAt: number, nowMs: number, sla: number, cal: Calendar): { label: string; at: number } | undefined {
  const bd = businessDaysElapsed(createdAt, nowMs, cal)
  const target = bd < 1 ? 1 : bd < sla ? sla : bd < sla + 1 ? sla + 1 : undefined
  if (target === undefined) return undefined
  const label = target === 1 && sla > 1 ? 'Reminder' : target === sla ? 'Routed to backup' : 'Escalation'
  for (let n = 1; n <= 120; n++) {
    const t = createdAt + n * DAY
    if (businessDaysElapsed(createdAt, t, cal) >= target) return { label, at: t }
  }
  return undefined
}
