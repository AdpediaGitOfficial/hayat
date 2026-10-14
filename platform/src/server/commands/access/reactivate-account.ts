import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { loginAttempt, userAccount } from '@/server/db/schema'
import { audit } from '@/server/audit'
import { runCommand } from '@/server/command/run'
import { failure, ok, type Result } from '@/server/command/result'
import type { RequestContext } from '@/server/command/context'
import { revokeAllSessions } from '@/server/auth/session'
import { normUsername } from '@/server/auth/login'
import { loadManagedAccount, newTemporaryCredential } from './guards'

export const input = z.object({ userId: z.uuid(), reason: z.string().trim().min(1, 'Say why').max(500) })
export type Input = z.infer<typeof input>
export const body = input.omit({ userId: true })
export interface Output { userId: string; username: string; temporaryPassword: string }

/**
 * Lets a deactivated account sign in again, with a NEW temporary password (shown once) and a forced change: the old
 * password is not brought back, because the reason for deactivating may have been that it was known to someone else.
 * Not for someone marked as Left (that is the re-hire path, Stage 3).
 */
export async function reactivateAccount(rc: RequestContext, raw: Input): Promise<Result<Output>> {
  return runCommand(rc, async c => {
    const t = await loadManagedAccount(c, raw.userId, 'reactivate')
    if ('ok' in t) return t
    if (t.status !== 'revoked' && !t.revokedAt) return failure('conflict', 'This account is not deactivated', { owner: 'Accommodation Admin', next: 'Nothing to do' })
    if (t.archivedAt) return failure('conflict', 'This account is archived', { owner: 'Super Admin', next: 'Create a new account for the person' })
    if (t.employmentStatus === 'left') {
      return failure('conflict', `${t.fullName ?? 'This person'} is marked as Left, so the login stays off`, { owner: 'Accommodation Admin', next: 'Use the re-hire process if they are returning' })
    }
    const cred = await newTemporaryCredential()
    await c.tx.update(userAccount).set({
      status: 'active', revokedAt: null, passwordHash: cred.hash, mustChangePassword: true, passwordChangedAt: null, failedLoginCount: 0, lockedUntil: null, updatedAt: c.now,
    }).where(eq(userAccount.id, t.id))
    await c.tx.insert(loginAttempt).values({ usernameNorm: normUsername(t.username), succeeded: true, createdAt: c.now })
    await revokeAllSessions(c.tx, t.id, 'reactivated', c.now) // belt and braces: nothing should be live
    await audit(c, {
      action: 'access.account.reactivated', entityType: 'user_account', entityId: t.id, siteId: t.siteIds[0], reason: raw.reason,
      before: { status: t.status }, after: { status: 'active', mustChangePassword: true },
    })
    return ok({ userId: t.id, username: t.username, temporaryPassword: cred.plain }, 'Account reactivated. Hand the temporary password over now: it cannot be shown again')
  })
}
