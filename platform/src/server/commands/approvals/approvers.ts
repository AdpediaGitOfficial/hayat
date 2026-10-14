/**
 * Who is an approver, and for which sites. Used by delegation (D-32): a stand-in must already hold an approver role in the
 * same site scope as the person they cover. Delegation never adds authority or scope (docs/STAGE-2.md S-13), so this is only
 * ever used to CHECK and to DESCRIBE, never to grant.
 */
import { buildActor, type Access } from '@/server/auth/actor'
import { scopeFilter, type Action } from '@/server/policy'

/** Actions that make somebody an approver of something (requests, exceptions, work orders, escalations). */
export const APPROVER_ACTIONS: readonly Action[] = [
  'requests_waitlist.approve', 'requests_waitlist.approve_exception', 'approvals_inbox.decide_route',
  'approvals_inbox.decide_workorder_route', 'approvals_inbox.decide_escalated',
]

export interface ApproverScope {
  /** For each approver action the person holds in at least one role: every site, or the listed ones. */
  byAction: Map<Action, { all: boolean; siteIds: Set<string> }>
}

/** Over every role the person holds (not just the mode they are in now), with their capability grants. */
export function approverScope(access: Access, staffId?: string): ApproverScope {
  const byAction: ApproverScope['byAction'] = new Map()
  const roles = [...new Set(access.assignments.map(a => a.role))]
  for (const role of roles) {
    const actor = buildActor(access, role, staffId)
    for (const action of APPROVER_ACTIONS) {
      const f = scopeFilter(actor, action)
      if (f.kind === 'none') continue
      const cur = byAction.get(action) ?? { all: false, siteIds: new Set<string>() }
      if (f.kind === 'all') cur.all = true
      else for (const s of f.siteIds) cur.siteIds.add(s)
      byAction.set(action, cur)
    }
  }
  return { byAction }
}

const hasSites = (s: { all: boolean; siteIds: Set<string> }) => s.all || s.siteIds.size > 0

/** Do the two people approve the same kind of thing for at least one common site? */
export function sharesApproverScope(a: ApproverScope, b: ApproverScope): boolean {
  for (const [action, x] of a.byAction) {
    const y = b.byAction.get(action)
    if (!y) continue
    if (x.all && hasSites(y)) return true
    if (y.all && hasSites(x)) return true
    for (const s of x.siteIds) if (y.siteIds.has(s)) return true
  }
  return false
}

/** Could this person decide something at this site (any approver action)? */
export function approvesAt(s: ApproverScope, siteId: string, action?: Action): boolean {
  for (const [a, x] of s.byAction) {
    if (action && a !== action) continue
    if (x.all || x.siteIds.has(siteId)) return true
  }
  return false
}

export const isApprover = (s: ApproverScope) => s.byAction.size > 0
