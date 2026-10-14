import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { capabilityGrant, userAccount } from '@/server/db/schema'
import { audit } from '@/server/audit'
import { authorize, notSelf } from '@/server/command/authorize'
import { runCommand } from '@/server/command/run'
import { fail, failure, ok, type Result } from '@/server/command/result'
import type { RequestContext } from '@/server/command/context'
import { loadTarget } from './guards'

export const decideInput = z.object({
  grantId: z.uuid(),
  decision: z.enum(['approve', 'reject']),
  note: z.string().trim().max(500).optional(),
})
export type DecideInput = z.infer<typeof decideInput>
export const decideBody = decideInput.omit({ grantId: true })
export interface DecideOutput { grantId: string; status: 'active' | 'rejected'; startsAt: string; expiresAt: string | null }

/**
 * Checker step (D-27): a DIFFERENT Super Admin than the maker, and never the holder (D-26). An approved grant is
 * `active`, but only works between its start and its expiry (the actor loader filters on both, on every request).
 * A rejected grant is final: the database refuses to reopen it.
 */
export async function decideGrant(rc: RequestContext, raw: DecideInput): Promise<Result<DecideOutput>> {
  return runCommand<DecideOutput>(rc, async c => {
    const denied = authorize(c, 'users_roles.approve_grant')
    if (denied) return denied
    const [g] = await c.tx.select().from(capabilityGrant).where(eq(capabilityGrant.id, raw.grantId)).limit(1).for('update')
    if (!g) return fail.notFound()
    if (g.status !== 'pending') return failure('conflict', `This grant was already ${g.status}`, { owner: 'Super Admin', next: 'File a new request if the capability is still needed' })
    if (g.makerId === c.user.id) return fail.sod('You requested this grant, so a different Super Admin must decide it', 'Ask another Super Admin to approve or reject it (maker-checker, D-27)')
    if (g.userId === c.user.id) return fail.sod('This grant is for your own account, so a different Super Admin must decide it', 'Ask another Super Admin to decide it')
    const target = await loadTarget(c.tx, g.userId)
    const self = notSelf(c, target?.staffId, 'decide a grant for your own account')
    if (self) return self
    const note = raw.note?.trim() || undefined
    const base = { targetUserId: g.userId, targetUsername: target?.username, capability: g.capability, makerId: g.makerId, startsAt: g.startsAt.toISOString(), expiresAt: g.expiresAt?.toISOString() ?? null }

    if (raw.decision === 'reject') {
      if (!note) return fail.invalid('Say why you are rejecting it', { note: 'Required' })
      await c.tx.update(capabilityGrant).set({ status: 'rejected', checkerId: c.user.id, decidedAt: c.now }).where(eq(capabilityGrant.id, g.id))
      await audit(c, { action: 'access.grant.rejected', entityType: 'capability_grant', entityId: g.id, reason: note, before: { status: 'pending' }, after: { status: 'rejected', ...base } })
      return ok({ grantId: g.id, status: 'rejected', startsAt: base.startsAt, expiresAt: base.expiresAt }, 'Rejected. The capability was not granted')
    }

    if (g.expiresAt && g.expiresAt.getTime() <= c.now.getTime()) {
      return failure('conflict', 'This grant ran out before anyone approved it', { owner: 'The Super Admin who filed it', next: 'Reject it, and file a new request with later dates' })
    }
    const [u] = await c.tx.select({ status: userAccount.status, revokedAt: userAccount.revokedAt }).from(userAccount).where(eq(userAccount.id, g.userId))
    if (!u || u.revokedAt || u.status === 'revoked') {
      return failure('conflict', 'The account was deactivated after the request was filed', { owner: 'Accommodation Admin or Super Admin', next: 'Reactivate the account, then file the request again' })
    }
    await c.tx.update(capabilityGrant).set({ status: 'active', checkerId: c.user.id, decidedAt: c.now }).where(eq(capabilityGrant.id, g.id))
    await audit(c, { action: 'access.grant.approved', entityType: 'capability_grant', entityId: g.id, reason: note ?? g.reason, before: { status: 'pending' }, after: { status: 'active', ...base } })
    return ok({ grantId: g.id, status: 'active', startsAt: base.startsAt, expiresAt: base.expiresAt },
      g.startsAt.getTime() > c.now.getTime() ? 'Approved. It starts on its start date' : 'Approved. It is in effect now')
  })
}
