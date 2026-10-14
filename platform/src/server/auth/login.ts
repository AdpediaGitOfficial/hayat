/**
 * Sign-in, sign-out, password change and mode switching (STAGE-1 section 2).
 *
 * Sign-in is deliberately NOT one runCommand: a refused sign-in must still persist its attempt (that is how
 * lockout works), while a successful one is a single transaction (session + attempt + audit). Every failure
 * about credentials or account state has the same wording and does the same amount of hashing work, so the
 * response never reveals whether a username exists.
 */
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm'
import { auditEvent, loginAttempt, session, userAccount } from '@/server/db/schema'
import { getDb } from '@/server/db/client'
import type { Clock } from '@/server/clock'
import type { Role } from '@/domain/enums'
import { fail, failure, ok, type Result } from '@/server/command/result'
import { runCommand } from '@/server/command/run'
import type { RequestContext } from '@/server/command/context'
import { audit } from '@/server/audit'
import { getConfig } from '@/server/config/registry'
import { availableModes, buildActor, chooseMode, loadAccess } from './actor'
import { burnVerify, hashPassword, passwordProblem, verifyPassword } from './password'
import { createSession, revokeAllSessions } from './session'

export const normUsername = (u: string) => u.trim().toLowerCase()
const BAD_CREDENTIALS = () => failure('unauthenticated', 'Wrong username or password', { next: 'Check them and try again, or ask an administrator to reset your password' })

export interface LoginInput { username: string; password: string; ip?: string; userAgent?: string; requestId: string; clock: Clock }
export interface LoginOk { token: string; expiresAt: Date; mustChangePassword: boolean; role: Role; modes: Role[] }

export async function login(input: LoginInput): Promise<Result<LoginOk>> {
  const db = getDb()
  const now = input.clock.now()
  const norm = normUsername(input.username)
  const max = await getConfig(db, 'auth.lockout_attempts')
  const windowMin = await getConfig(db, 'auth.lockout_minutes')
  const windowStart = new Date(now.getTime() - windowMin * 60_000)

  // Lockout is decided from the attempt log so it works identically for names that do not exist.
  const [lastOk] = await db.select({ at: loginAttempt.createdAt }).from(loginAttempt)
    .where(and(eq(loginAttempt.usernameNorm, norm), eq(loginAttempt.succeeded, true))).orderBy(desc(loginAttempt.createdAt)).limit(1)
  const since = lastOk && lastOk.at > windowStart ? lastOk.at : windowStart
  const recent = await db.select({ at: loginAttempt.createdAt }).from(loginAttempt)
    .where(and(eq(loginAttempt.usernameNorm, norm), eq(loginAttempt.succeeded, false), gt(loginAttempt.createdAt, since)))
    .orderBy(desc(loginAttempt.createdAt)).limit(max)

  const [user] = await db.select().from(userAccount).where(sql`lower(btrim(${userAccount.username})) = ${norm}`).limit(1)

  // One address trying many usernames (password spraying) is capped too: 4x the per-account limit in the same window.
  if (input.ip) {
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(loginAttempt)
      .where(and(sql`${loginAttempt.ip} = ${input.ip}::inet`, eq(loginAttempt.succeeded, false), gt(loginAttempt.createdAt, windowStart)))
    if (n >= max * 4) {
      await burnVerify(input.password)
      return fail.rateLimited(windowMin)
    }
  }

  let lockedUntil: Date | undefined
  if (recent.length >= max) lockedUntil = new Date(recent[0].at.getTime() + windowMin * 60_000)
  if (user?.lockedUntil && user.lockedUntil > now && (!lockedUntil || user.lockedUntil > lockedUntil)) lockedUntil = user.lockedUntil
  if (lockedUntil && lockedUntil > now) {
    await burnVerify(input.password)
    return fail.rateLimited(Math.max(1, Math.ceil((lockedUntil.getTime() - now.getTime()) / 60_000)))
  }

  const usable = !!user && !!user.passwordHash && !user.revokedAt && !user.archivedAt && (user.status === 'active' || user.status === 'invited')
  const good = usable ? await verifyPassword(user.passwordHash!, input.password) : await burnVerify(input.password)
  if (!usable || !good) {
    const failedNow = recent.length + 1
    await db.transaction(async tx => {
      await tx.insert(loginAttempt).values({ usernameNorm: norm, ip: input.ip ?? null, succeeded: false, createdAt: now })
      if (user) {
        const locks = failedNow >= max
        await tx.update(userAccount).set({
          failedLoginCount: failedNow, lockedUntil: locks ? new Date(now.getTime() + windowMin * 60_000) : user.lockedUntil, updatedAt: now,
        }).where(eq(userAccount.id, user.id))
        if (locks) {
          await tx.insert(auditEvent).values({
            actorUserId: null, action: 'auth.account_locked', entityType: 'user_account', entityId: user.id,
            after: { failedAttempts: failedNow, minutes: windowMin }, requestId: input.requestId, ip: input.ip ?? null,
          })
        }
      }
    })
    return BAD_CREDENTIALS()
  }

  const access = await loadAccess(db, user!.id, now)
  const role = chooseMode(access)
  if (!role) {
    return failure('forbidden', 'This account has no role yet', { owner: 'Administrator', next: 'Ask an administrator to assign a role' })
  }
  const actor = buildActor(access, role, user!.staffId ?? undefined)
  const rc: RequestContext = { actor, user: { id: user!.id, username: user!.username, staffId: user!.staffId ?? undefined }, requestId: input.requestId, ip: input.ip, clock: input.clock }
  return runCommand(rc, async c => {
    await c.tx.insert(loginAttempt).values({ usernameNorm: norm, ip: input.ip ?? null, succeeded: true, createdAt: now })
    await c.tx.update(userAccount).set({
      failedLoginCount: 0, lockedUntil: null, lastLoginAt: now, status: 'active', updatedAt: now,
    }).where(eq(userAccount.id, user!.id))
    const s = await createSession(c.tx, { userId: user!.id, role, now, ip: input.ip, userAgent: input.userAgent })
    await audit(c, { action: 'auth.login', entityType: 'session', entityId: s.sessionId, after: { role } })
    return ok({ token: s.token, expiresAt: s.expiresAt, mustChangePassword: user!.mustChangePassword, role, modes: availableModes(access) })
  })
}

export async function logout(rc: RequestContext): Promise<Result> {
  if (!rc.sessionId) return fail.unauthenticated()
  return runCommand(rc, async c => {
    await c.tx.update(session).set({ revokedAt: c.now, revokedReason: 'signed_out' }).where(and(eq(session.id, rc.sessionId!), isNull(session.revokedAt)))
    await audit(c, { action: 'auth.logout', entityType: 'session', entityId: rc.sessionId })
    return ok(undefined)
  })
}

/** Allowed even while must_change_password is set. Ends the user's OTHER sessions (a stolen one dies with the old password). */
export async function changePassword(rc: RequestContext, input: { current: string; next: string }): Promise<Result> {
  return runCommand(rc, async c => {
    const [u] = await c.tx.select().from(userAccount).where(eq(userAccount.id, c.user.id)).for('update')
    if (!u?.passwordHash || !(await verifyPassword(u.passwordHash, input.current))) {
      return fail.invalid('The current password is wrong', { current: 'Wrong password' })
    }
    const minLength = await getConfig(c.tx, 'auth.password_min_length')
    const problem = passwordProblem(input.next, { username: u.username, minLength })
    if (problem) return fail.invalid(problem, { next: problem })
    if (input.next === input.current) return fail.invalid('Choose a password you have not used just now', { next: 'Must be different' })
    await c.tx.update(userAccount).set({
      passwordHash: await hashPassword(input.next), mustChangePassword: false, passwordChangedAt: c.now, updatedAt: c.now,
    }).where(eq(userAccount.id, u.id))
    const ended = await revokeAllSessions(c.tx, u.id, 'password_changed', c.now, c.sessionId)
    await audit(c, { action: 'auth.password_changed', entityType: 'user_account', entityId: u.id, after: { otherSessionsEnded: ended } })
    return ok(undefined, 'Password changed')
  })
}

/** Switch the active mode (S-2). Only to a role the user holds. Nothing from the old mode carries over. */
export async function switchRole(rc: RequestContext, role: Role): Promise<Result<{ role: Role }>> {
  return runCommand(rc, async c => {
    if (!c.sessionId) return fail.unauthenticated()
    const access = await loadAccess(c.tx, c.user.id, c.now)
    if (!availableModes(access).includes(role)) return fail.notFound()
    await c.tx.update(session).set({ activeRole: role }).where(eq(session.id, c.sessionId))
    await audit(c, { action: 'auth.mode_switched', entityType: 'session', entityId: c.sessionId, before: { role: c.actor.role }, after: { role } })
    return ok({ role })
  })
}
