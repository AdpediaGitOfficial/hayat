import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { loginAttempt, userAccount } from '@/server/db/schema'
import { audit } from '@/server/audit'
import { runCommand } from '@/server/command/run'
import { failure, ok, type Result } from '@/server/command/result'
import type { RequestContext } from '@/server/command/context'
import { revokeAllSessions } from '@/server/auth/session'
import { loadManagedAccount, newTemporaryCredential } from './guards'
import { normUsername } from '@/server/auth/login'

export const input = z.object({ userId: z.uuid(), reason: z.string().trim().max(500).optional() })
export type Input = z.infer<typeof input>
/** What the route takes in the body; the user comes from the path. */
export const body = input.omit({ userId: true })
export interface Output { userId: string; username: string; temporaryPassword: string; sessionsEnded: number }

/**
 * Admin-assisted reset (D-08): AA for staff accounts in their sites, SA for administrator accounts.
 * A new temporary password is shown once; every session of the user ends; a lockout is cleared; the user must choose
 * their own password at the next sign-in. Nobody resets their own password this way (D-26).
 */
export async function resetPassword(rc: RequestContext, raw: Input): Promise<Result<Output>> {
  return runCommand(rc, async c => {
    const t = await loadManagedAccount(c, raw.userId, 'reset the password of')
    if ('ok' in t) return t
    if (t.status === 'revoked' || t.revokedAt) {
      return failure('conflict', 'This account is deactivated, so a new password would not let anyone in', { owner: 'Accommodation Admin', next: 'Reactivate the account (that also issues a new temporary password)' })
    }
    const cred = await newTemporaryCredential()
    await c.tx.update(userAccount).set({
      passwordHash: cred.hash, mustChangePassword: true, passwordChangedAt: null, failedLoginCount: 0, lockedUntil: null, updatedAt: c.now,
    }).where(eq(userAccount.id, t.id))
    // Sign-in counts failures since the last success: recording the unlock keeps an old burst of failures from re-locking the account.
    await c.tx.insert(loginAttempt).values({ usernameNorm: normUsername(t.username), succeeded: true, createdAt: c.now })
    const ended = await revokeAllSessions(c.tx, t.id, 'password_reset', c.now)
    await audit(c, {
      action: 'access.account.password_reset', entityType: 'user_account', entityId: t.id, siteId: t.siteIds[0], reason: raw.reason,
      after: { username: t.username, mustChangePassword: true, sessionsEnded: ended, unlocked: t.failedLoginCount > 0 || (t.lockedUntil !== null && t.lockedUntil > c.now) },
    })
    return ok({ userId: t.id, username: t.username, temporaryPassword: cred.plain, sessionsEnded: ended },
      'Password reset. Hand the temporary password over now: it cannot be shown again')
  })
}
