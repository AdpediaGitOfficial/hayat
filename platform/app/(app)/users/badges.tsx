import { Badge } from '@/ui'
import type { GrantState } from '@/server/queries/access/users'

export const accountBadge = (u: { status: string; mustChangePassword: boolean }) =>
  u.status === 'revoked' ? <Badge tone="danger">Deactivated</Badge>
    : u.status === 'locked' ? <Badge tone="warning">Locked</Badge>
    : u.status === 'invited' ? <Badge tone="info">Invited · not signed in yet</Badge>
    : u.mustChangePassword ? <Badge tone="warning">Must change password</Badge>
    : <Badge tone="success">Active</Badge>

const GRANT: Record<GrantState, { tone: 'brand' | 'info' | 'success' | 'neutral' | 'danger'; label: string }> = {
  pending: { tone: 'brand', label: 'Waiting for a second Super Admin' },
  scheduled: { tone: 'info', label: 'Approved, not started' },
  active: { tone: 'success', label: 'In effect' },
  expired: { tone: 'neutral', label: 'Expired' },
  rejected: { tone: 'danger', label: 'Rejected' },
  revoked: { tone: 'neutral', label: 'Revoked' },
}
export const grantBadge = (s: GrantState) => <Badge tone={GRANT[s].tone}>{GRANT[s].label}</Badge>

const REQ: Record<string, { tone: 'brand' | 'success' | 'danger' | 'neutral'; label: string }> = {
  pending: { tone: 'brand', label: 'Waiting for a second Super Admin' }, approved: { tone: 'success', label: 'Approved and applied' },
  rejected: { tone: 'danger', label: 'Rejected' }, cancelled: { tone: 'neutral', label: 'Withdrawn' },
}
export const requestBadge = (s: string) => <Badge tone={(REQ[s] ?? REQ.cancelled).tone}>{(REQ[s] ?? { label: s }).label}</Badge>

export const fmtUtc = (iso: string | null) => (iso ? `${iso.replace('T', ' ').slice(0, 16)} UTC` : 'Never')
