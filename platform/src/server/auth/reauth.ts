/**
 * Re-confirmation of the actor's own password on high-risk actions (D-03: Mark as Left, clearance waiver, rehire, ...).
 * It compensates for there being no second factor. Call it INSIDE the command, early, before any write:
 *   const denied = await confirmPassword(c, input.confirmPassword); if (denied) return denied
 * Wrong attempts are counted and throttled like sign-in (same configured limits). The failed attempt is recorded outside
 * the command's transaction, because the command rolls back when it refuses and the count must survive that.
 */
import { and, eq, gt, sql } from 'drizzle-orm'
import { loginAttempt, userAccount } from '@/server/db/schema'
import { getDb } from '@/server/db/client'
import type { CommandContext, RequestContext } from '@/server/command/context'
import { fail, type Failure } from '@/server/command/result'
import { getConfig } from '@/server/config/registry'
import { verifyPassword } from './password'

const key = (userId: string) => `reauth:${userId}`

export async function confirmPassword(c: CommandContext, password: string | undefined): Promise<Failure | undefined> {
  if (!password) return fail.invalid('Enter your password to confirm this action', { confirmPassword: 'Required' })
  const db = getDb()
  const max = await getConfig(db, 'auth.lockout_attempts')
  const windowMin = await getConfig(db, 'auth.lockout_minutes')
  const since = new Date(c.now.getTime() - windowMin * 60_000)
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(loginAttempt)
    .where(and(eq(loginAttempt.usernameNorm, key(c.user.id)), eq(loginAttempt.succeeded, false), gt(loginAttempt.createdAt, since)))
  if (n >= max) return fail.rateLimited(windowMin)

  const [u] = await c.tx.select({ hash: userAccount.passwordHash }).from(userAccount).where(eq(userAccount.id, c.user.id)).limit(1)
  if (!u?.hash || !(await verifyPassword(u.hash, password))) {
    await db.insert(loginAttempt).values({ usernameNorm: key(c.user.id), ip: c.ip ?? null, succeeded: false, createdAt: c.now })
    return fail.invalid('That password is not right', { confirmPassword: 'Wrong password' })
  }
  return undefined
}

/**
 * The same check at the API layer, for routes that declare `reauth` (src/server/http.ts): used where the command itself is
 * called from many places, so the API is where D-03 is enforced. Same throttle, same persisted failures.
 */
export async function confirmPasswordRc(rc: RequestContext, password: string | undefined): Promise<Failure | undefined> {
  if (!password) return fail.invalid('Enter your password to confirm this action', { confirmPassword: 'Required' })
  const db = getDb()
  const now = rc.clock.now()
  const max = await getConfig(db, 'auth.lockout_attempts')
  const windowMin = await getConfig(db, 'auth.lockout_minutes')
  const since = new Date(now.getTime() - windowMin * 60_000)
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(loginAttempt)
    .where(and(eq(loginAttempt.usernameNorm, key(rc.user.id)), eq(loginAttempt.succeeded, false), gt(loginAttempt.createdAt, since)))
  if (n >= max) return fail.rateLimited(windowMin)
  const [u] = await db.select({ hash: userAccount.passwordHash }).from(userAccount).where(eq(userAccount.id, rc.user.id)).limit(1)
  if (!u?.hash || !(await verifyPassword(u.hash, password))) {
    await db.insert(loginAttempt).values({ usernameNorm: key(rc.user.id), ip: rc.ip ?? null, succeeded: false, createdAt: now })
    return fail.invalid('That password is not right', { confirmPassword: 'Wrong password' })
  }
  return undefined
}

/** Is this action configured to re-ask for the password at the API? Server components use it to show the field only when needed. */
export async function reauthEnabled(action: 'emergency.initiate' | 'emergency.decide' | 'access.role_change' | 'access.grant' | 'waitlist.queue_override'): Promise<boolean> {
  return (await getConfig(getDb(), 'auth.reauth_actions')).includes(action)
}
