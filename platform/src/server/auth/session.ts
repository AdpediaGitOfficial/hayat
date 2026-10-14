/**
 * Sessions (STAGE-1 section 2): an opaque 32-byte token in an HttpOnly cookie; only its SHA-256 is stored.
 * Expiry is checked against the row on every request, so revoking is an UPDATE and takes effect at once.
 */
import { createHash, randomBytes } from 'node:crypto'
import { and, eq, isNull, ne, sql } from 'drizzle-orm'
import { session, userAccount } from '@/server/db/schema'
import type { Db } from '@/server/db/client'
import type { Tx } from '@/server/command/context'
import type { Role } from '@/domain/enums'
import { getConfig } from '@/server/config/registry'

export const COOKIE_NAME = 'gh_session'

/** Roles that get the long, phone-friendly session; everyone else is a staff role with the stricter one. */
const RELAXED: readonly Role[] = ['Res', 'Tech', 'Vend']

export const newToken = () => randomBytes(32).toString('base64url')
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex')

export interface SessionLimits { idleMs: number; absoluteMs: number }
export async function limitsFor(q: Pick<Db, 'select'>, role: Role): Promise<SessionLimits> {
  if (RELAXED.includes(role)) {
    return {
      idleMs: (await getConfig(q, 'auth.resident_idle_minutes')) * 60_000,
      absoluteMs: (await getConfig(q, 'auth.resident_absolute_days')) * 86_400_000,
    }
  }
  return {
    idleMs: (await getConfig(q, 'auth.admin_idle_minutes')) * 60_000,
    absoluteMs: (await getConfig(q, 'auth.admin_absolute_hours')) * 3_600_000,
  }
}

export async function createSession(tx: Tx, a: { userId: string; role: Role; now: Date; ip?: string; userAgent?: string }) {
  const token = newToken()
  const { absoluteMs } = await limitsFor(tx, a.role)
  const expiresAt = new Date(a.now.getTime() + absoluteMs)
  const [row] = await tx.insert(session).values({
    userId: a.userId, tokenHash: hashToken(token), expiresAt, lastSeenAt: a.now, createdAt: a.now,
    ip: a.ip ?? null, userAgent: a.userAgent?.slice(0, 300) ?? null, activeRole: a.role,
  }).returning({ id: session.id })
  return { token, sessionId: row.id, expiresAt }
}

export type SessionRow = typeof session.$inferSelect
export type UserRow = typeof userAccount.$inferSelect
export type Resolved =
  | { ok: true; session: SessionRow; user: UserRow }
  | { ok: false; reason: 'missing' | 'expired' | 'idle' | 'revoked' | 'user_disabled' }

const TOUCH_EVERY_MS = 60_000

/**
 * Looks a token up and decides whether it is still good. Idle expiry revokes the row (reason 'idle') so a later
 * request cannot revive it. Activity is recorded at most once a minute to keep reads cheap.
 */
export async function resolveSession(db: Db, token: string | undefined, now: Date): Promise<Resolved> {
  if (!token || token.length < 20 || token.length > 100) return { ok: false, reason: 'missing' }
  const rows = await db.select({ s: session, u: userAccount }).from(session)
    .innerJoin(userAccount, eq(userAccount.id, session.userId))
    .where(eq(session.tokenHash, hashToken(token))).limit(1)
  if (rows.length === 0) return { ok: false, reason: 'missing' }
  const { s, u } = rows[0]
  if (s.revokedAt) return { ok: false, reason: 'revoked' }
  if (u.revokedAt || u.archivedAt || u.status === 'revoked') return { ok: false, reason: 'user_disabled' }
  if (s.expiresAt.getTime() <= now.getTime()) return { ok: false, reason: 'expired' }
  const { idleMs } = await limitsFor(db, s.activeRole ?? 'Res')
  if (now.getTime() - s.lastSeenAt.getTime() > idleMs) {
    await db.update(session).set({ revokedAt: now, revokedReason: 'idle' }).where(and(eq(session.id, s.id), isNull(session.revokedAt)))
    return { ok: false, reason: 'idle' }
  }
  if (now.getTime() - s.lastSeenAt.getTime() > TOUCH_EVERY_MS) {
    await db.update(session).set({ lastSeenAt: now }).where(eq(session.id, s.id))
  }
  return { ok: true, session: s, user: u }
}

export async function revokeSession(q: Pick<Db, 'update'>, sessionId: string, reason: string, now: Date): Promise<void> {
  await q.update(session).set({ revokedAt: now, revokedReason: reason }).where(and(eq(session.id, sessionId), isNull(session.revokedAt)))
}

/**
 * Ends every live session of a user (Mark as Left, deactivation, password reset, role change). Returns how many ended.
 * `exceptSessionId` keeps the caller's own session, for "sign out my other devices".
 */
export async function revokeAllSessions(q: Pick<Db, 'update'>, userId: string, reason: string, now: Date, exceptSessionId?: string): Promise<number> {
  const rows = await q.update(session).set({ revokedAt: now, revokedReason: reason })
    .where(and(eq(session.userId, userId), isNull(session.revokedAt), exceptSessionId ? ne(session.id, exceptSessionId) : sql`true`))
    .returning({ id: session.id })
  return rows.length
}

/* ---------------- cookie ---------------- */

export function sessionCookie(token: string, expiresAt: Date, secure = process.env.NODE_ENV === 'production'): string {
  return [`${COOKIE_NAME}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Expires=${expiresAt.toUTCString()}`, secure ? 'Secure' : ''].filter(Boolean).join('; ')
}
export function clearedCookie(secure = process.env.NODE_ENV === 'production'): string {
  return [`${COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0', secure ? 'Secure' : ''].filter(Boolean).join('; ')
}
export function readCookie(header: string | null | undefined, name = COOKIE_NAME): string | undefined {
  if (!header) return undefined
  for (const part of header.split(';')) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim()
  }
  return undefined
}
