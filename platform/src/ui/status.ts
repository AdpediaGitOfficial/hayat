/** One status, one tone, everywhere. Plain module (no 'use client') so server components can use it. */
export type Tone = 'success' | 'info' | 'warning' | 'danger' | 'brand' | 'neutral' | 'champagne'

const STATUS_TONE: Record<string, Tone> = {
  // bed physical
  Available: 'info', Occupied: 'brand', NeedsCleaning: 'warning', InspectionRequired: 'warning', Blocked: 'neutral', UnderMaintenance: 'neutral', Archived: 'neutral',
  // request / approval
  Submitted: 'brand', Approved: 'success', Rejected: 'danger', Cancelled: 'neutral', Waitlisted: 'info',
  // reservation / stay
  Reserved: 'info', CheckedIn: 'success', Expired: 'danger', Active: 'success', Ended: 'neutral', Provisional: 'info', 'No-show': 'danger',
  'Not ready': 'warning', Expected: 'info', 'Checked in': 'success', 'Checkout due': 'warning', Overdue: 'danger',
  // offers & waitlist
  Pending: 'brand', Accepted: 'success', Declined: 'neutral', Waiting: 'info', Offered: 'brand', Closed: 'neutral',
  // clearance & work
  Open: 'warning', Resolved: 'info', Verified: 'success', Done: 'success', Waived: 'info', 'In progress': 'info',
  // emergency
  Escalated: 'danger', Executed: 'success', Failed: 'danger', ChangesRequested: 'warning', Denied: 'danger', Revoked: 'danger',
  'Pre-registered': 'brand', 'Walk-in pending': 'warning', 'Gate pass valid': 'info', 'Checked out': 'neutral',
  Left: 'neutral',
}
export const statusTone = (s: string): Tone => STATUS_TONE[s] ?? 'neutral'
const LABELS: Record<string, string> = {
  NeedsCleaning: 'Needs cleaning', InspectionRequired: 'Inspection required', UnderMaintenance: 'Under maintenance', CheckedIn: 'Checked in',
  Failed: 'Approved, action failed', ChangesRequested: 'Changes requested',
}
export const statusLabel = (s: string): string => LABELS[s] ?? s
