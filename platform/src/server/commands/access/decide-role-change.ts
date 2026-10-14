import { z } from 'zod'
import { and, eq, isNull } from 'drizzle-orm'
import { roleAssignment } from '@/server/db/schema'
import { roleChangeRequest } from '@/server/db/schema.access'
import { audit } from '@/server/audit'
import { authorize, notSelf } from '@/server/command/authorize'
import { runCommand } from '@/server/command/run'
import { fail, failure, ok, type Result } from '@/server/command/result'
import type { RequestContext } from '@/server/command/context'
import { revokeAllSessions } from '@/server/auth/session'
import { lastSuperAdminFailure, loadTarget, lockSuperAdmins } from './guards'
import { checkRoleSpec } from './role-change-core'

export const input = z.object({
  requestId: z.uuid(),
  decision: z.enum(['approve', 'reject']),
  note: z.string().trim().max(500).optional(),
})
export type Input = z.infer<typeof input>
export const body = input.omit({ requestId: true })
export interface Output { requestId: string; status: 'approved' | 'rejected'; sessionsEnded: number }

/**
 * Checker step (D-27). A DIFFERENT Super Admin than the maker, and never the person the change is about (D-26),
 * decides. Approving applies the change in this same transaction and ends the person's sessions, so the next request
 * rebuilds their access from the new assignments. The last active Super Admin can never lose the role: checked under a lock.
 */
export async function decideRoleChange(rc: RequestContext, raw: Input): Promise<Result<Output>> {
  return runCommand<Output>(rc, async c => {
    const denied = authorize(c, 'users_roles.manage_roles_and_scope')
    if (denied) return denied
    await lockSuperAdmins(c.tx) // before any row lock: one fixed order

    const [req] = await c.tx.select().from(roleChangeRequest).where(eq(roleChangeRequest.id, raw.requestId)).limit(1).for('update')
    if (!req) return fail.notFound()
    if (req.status !== 'pending') return failure('conflict', `This request was already ${req.status}`, { owner: 'Super Admin', next: 'Nothing to do; file a new request if the change is still needed' })
    if (req.makerId === c.user.id) return fail.sod('You filed this request, so a different Super Admin must decide it', 'Ask another Super Admin to approve or reject it (maker-checker, D-27)')
    if (req.targetUserId === c.user.id) return fail.sod('This change is about your own access, so a different Super Admin must decide it', 'Ask another Super Admin to decide it')

    const target = await loadTarget(c.tx, req.targetUserId, { lock: true })
    if (!target) return fail.notFound()
    const self = notSelf(c, target.staffId, 'decide a change to your own access')
    if (self) return self

    const spec = { role: req.role, scopeKind: req.scopeKind, siteId: req.siteId, buildingId: req.buildingId }
    const note = raw.note?.trim() || undefined

    if (raw.decision === 'reject') {
      if (!note) return fail.invalid('Say why you are rejecting it', { note: 'Required' })
      await c.tx.update(roleChangeRequest).set({ status: 'rejected', checkerId: c.user.id, decidedAt: c.now, decisionNote: note }).where(eq(roleChangeRequest.id, req.id))
      await audit(c, {
        action: 'access.role_change.rejected', entityType: 'role_change_request', entityId: req.id, siteId: req.siteId ?? undefined, reason: note,
        before: { status: 'pending' }, after: { status: 'rejected', targetUserId: target.id, targetUsername: target.username, kind: req.kind, ...spec, makerId: req.makerId },
      })
      return ok({ requestId: req.id, status: 'rejected', sessionsEnded: 0 }, 'Rejected. Nothing changed')
    }

    if (target.revokedAt || target.archivedAt || target.status === 'revoked') {
      return failure('conflict', 'This account was deactivated after the request was filed', { owner: 'Accommodation Admin or Super Admin', next: 'Reactivate the account, then file the request again' })
    }

    let assignmentId: string
    if (req.kind === 'add') {
      const bad = await checkRoleSpec(c, spec)
      if (bad) return bad
      const dup = target.assignments.find(a => a.role === spec.role && a.scopeKind === spec.scopeKind && a.siteId === spec.siteId && a.buildingId === spec.buildingId)
      if (dup) return failure('conflict', 'The person already holds this role with this scope', { owner: 'Super Admin', next: 'Reject this request as no longer needed' })
      const [row] = await c.tx.insert(roleAssignment).values({
        userId: target.id, role: spec.role, scopeKind: spec.scopeKind, siteId: spec.siteId, buildingId: spec.buildingId, grantedBy: c.user.id, createdAt: c.now,
      }).returning({ id: roleAssignment.id })
      assignmentId = row.id
    } else {
      const a = target.assignments.find(x => x.id === req.assignmentId)
      if (!a) return failure('conflict', 'That assignment has already ended', { owner: 'Super Admin', next: 'Reject this request as no longer needed' })
      if (a.role === 'SA') {
        const last = await lastSuperAdminFailure(c.tx, target.id)
        if (last) return last
      }
      await c.tx.update(roleAssignment).set({ revokedAt: c.now }).where(and(eq(roleAssignment.id, a.id), isNull(roleAssignment.revokedAt)))
      assignmentId = a.id
    }
    await c.tx.update(roleChangeRequest).set({
      status: 'approved', checkerId: c.user.id, decidedAt: c.now, decisionNote: note ?? null, resultingAssignmentId: req.kind === 'add' ? assignmentId : null,
    }).where(eq(roleChangeRequest.id, req.id))
    const ended = await revokeAllSessions(c.tx, target.id, 'role_changed', c.now)

    await audit(c, {
      action: 'access.role_change.approved', entityType: 'role_change_request', entityId: req.id, siteId: req.siteId ?? undefined, reason: note ?? req.reason,
      before: { status: 'pending' }, after: { status: 'approved', targetUserId: target.id, targetUsername: target.username, kind: req.kind, ...spec, assignmentId, makerId: req.makerId, sessionsEnded: ended },
    })
    await audit(c, {
      action: req.kind === 'add' ? 'access.role.assigned' : 'access.role.removed', entityType: 'user_account', entityId: target.id, siteId: req.siteId ?? undefined, reason: req.reason,
      before: req.kind === 'remove' ? { assignmentId, ...spec } : null, after: req.kind === 'add' ? { assignmentId, ...spec } : null,
    })
    return ok({ requestId: req.id, status: 'approved', sessionsEnded: ended }, 'Approved and applied. The person was signed out and sees the new access at the next sign-in')
  })
}
