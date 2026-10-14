import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { userAccount } from '@/server/db/schema'
import { audit } from '@/server/audit'
import { runCommand } from '@/server/command/run'
import { failure, ok, type Result } from '@/server/command/result'
import type { RequestContext } from '@/server/command/context'
import { revokeAllSessions } from '@/server/auth/session'
import { lastSuperAdminFailure, loadManagedAccount, lockSuperAdmins } from './guards'

export const input = z.object({ userId: z.uuid(), reason: z.string().trim().min(1, 'Say why').max(500) })
export type Input = z.infer<typeof input>
export const body = input.omit({ userId: true })
export interface Output { userId: string; sessionsEnded: number }

/**
 * Revokes the login at once: status `revoked`, every session ended in the same transaction. Nothing else changes
 * (a bed is never freed by this; only an actual checkout does that). The last active Super Admin can't be deactivated:
 * the check runs under a lock, so two Super Admins deactivating each other at the same moment cannot both succeed (D-27).
 */
export async function deactivateAccount(rc: RequestContext, raw: Input): Promise<Result<Output>> {
  return runCommand(rc, async c => {
    await lockSuperAdmins(c.tx) // first, before any row lock: one fixed order for everything that can remove a Super Admin
    const t = await loadManagedAccount(c, raw.userId, 'deactivate')
    if ('ok' in t) return t
    if (t.status === 'revoked' || t.revokedAt) return failure('conflict', 'This account is already deactivated', { owner: 'Accommodation Admin', next: 'Nothing to do' })
    const last = await lastSuperAdminFailure(c.tx, t.id)
    if (last) return last
    await c.tx.update(userAccount).set({ status: 'revoked', revokedAt: c.now, updatedAt: c.now }).where(eq(userAccount.id, t.id))
    const ended = await revokeAllSessions(c.tx, t.id, 'deactivated', c.now)
    await audit(c, {
      action: 'access.account.deactivated', entityType: 'user_account', entityId: t.id, siteId: t.siteIds[0], reason: raw.reason,
      before: { status: t.status }, after: { status: 'revoked', sessionsEnded: ended },
    })
    return ok({ userId: t.id, sessionsEnded: ended }, 'Account deactivated. Their sign-in stopped working immediately')
  })
}
