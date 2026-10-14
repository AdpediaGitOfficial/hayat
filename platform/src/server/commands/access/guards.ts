/**
 * Shared rules for user administration (WP-C). Nothing here writes business data; commands and queries call these
 * to decide who may touch which account and to protect the last Super Admin.
 *
 * Reading of the matrix (docs/PERMISSIONS.md, D-08):
 *  - A Super Admin manages every account.
 *  - An Accommodation Admin manages STAFF accounts inside their own sites: an account holding no administrator role
 *    (SA, AA, Mgr, Aud) and no global assignment, whose sites (the site it was created for plus its site-scoped
 *    roles) are all among the AA's sites. An account with no site at all is a Super Admin's to manage.
 *  - What an actor may SEE is wider than what they may CHANGE: any account sharing one of their sites is visible,
 *    anything else answers 404 (AT-001/002).
 */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import { accountSite } from '@/server/db/schema.access'
import { roleAssignment, staffProfile, userAccount } from '@/server/db/schema'
import type { Db } from '@/server/db/client'
import type { Tx, CommandContext } from '@/server/command/context'
import { authorize, notSelf } from '@/server/command/authorize'
import { fail, failure, type Failure } from '@/server/command/result'
import type { Actor } from '@/server/policy'
import type { Role, ScopeKind } from '@/domain/enums'
import { hashPassword, temporaryPassword } from '@/server/auth/password'
import { ADMIN_TYPE_ROLES } from './rules'

export { ADMIN_TYPE_ROLES, ROLE_SCOPE_KINDS } from './rules'

export const isFullSuperAdmin = (a: Actor) => a.role === 'SA' && a.sites === 'all'

export interface TargetAssignment { id: string; role: Role; scopeKind: ScopeKind; siteId: string | null; buildingId: string | null }
export interface AccountTarget {
  id: string
  username: string
  status: 'invited' | 'active' | 'locked' | 'revoked'
  mustChangePassword: boolean
  failedLoginCount: number
  lockedUntil: Date | null
  lastLoginAt: Date | null
  revokedAt: Date | null
  archivedAt: Date | null
  staffId: string | null
  employeeId: string | null
  fullName: string | null
  employmentStatus: 'active' | 'left' | null
  assignments: TargetAssignment[]
  /** The site the account was created for plus the sites of its site-scoped roles. */
  siteIds: string[]
  /** Holds a Super Admin / Accommodation Admin / Manager / Auditor role, or any global assignment. */
  adminType: boolean
}

type Reader = Pick<Db, 'select'>

export async function accountSiteIds(q: Reader, userIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>()
  if (userIds.length === 0) return out
  const own = await q.select({ userId: accountSite.userId, siteId: accountSite.siteId }).from(accountSite)
    .where(and(inArray(accountSite.userId, userIds), isNull(accountSite.archivedAt)))
  const viaRole = await q.select({ userId: roleAssignment.userId, siteId: roleAssignment.siteId }).from(roleAssignment)
    .where(and(inArray(roleAssignment.userId, userIds), isNull(roleAssignment.revokedAt), sql`${roleAssignment.siteId} is not null`))
  for (const r of [...own, ...viaRole]) {
    if (!r.siteId) continue
    const list = out.get(r.userId) ?? []
    if (!list.includes(r.siteId)) list.push(r.siteId)
    out.set(r.userId, list)
  }
  return out
}

export const isAdminType = (assignments: readonly Pick<TargetAssignment, 'role' | 'scopeKind'>[]) =>
  assignments.some(a => ADMIN_TYPE_ROLES.includes(a.role) || a.scopeKind === 'all')

/** Loads an account with its roles and sites. `lock` takes a row lock (FOR UPDATE) on the user row. */
export async function loadTarget(q: Reader, userId: string, opts: { lock?: boolean } = {}): Promise<AccountTarget | undefined> {
  const base = q.select().from(userAccount).where(eq(userAccount.id, userId)).limit(1)
  const [u] = opts.lock ? await base.for('update') : await base
  if (!u) return undefined
  const assignments = (await q.select({
    id: roleAssignment.id, role: roleAssignment.role, scopeKind: roleAssignment.scopeKind, siteId: roleAssignment.siteId, buildingId: roleAssignment.buildingId,
  }).from(roleAssignment).where(and(eq(roleAssignment.userId, userId), isNull(roleAssignment.revokedAt)))) as TargetAssignment[]
  const [staff] = u.staffId
    ? await q.select({ employeeId: staffProfile.employeeId, fullName: staffProfile.fullName, employmentStatus: staffProfile.employmentStatus }).from(staffProfile).where(eq(staffProfile.id, u.staffId))
    : []
  const sites = await accountSiteIds(q, [userId])
  return {
    id: u.id, username: u.username, status: u.status, mustChangePassword: u.mustChangePassword, failedLoginCount: u.failedLoginCount,
    lockedUntil: u.lockedUntil, lastLoginAt: u.lastLoginAt, revokedAt: u.revokedAt, archivedAt: u.archivedAt,
    staffId: u.staffId, employeeId: staff?.employeeId ?? null, fullName: staff?.fullName ?? null, employmentStatus: staff?.employmentStatus ?? null,
    assignments, siteIds: sites.get(userId) ?? [], adminType: isAdminType(assignments),
  }
}

/** May the actor see this account at all? Anything else must read as "not found". */
export function targetVisibleTo(actor: Actor, t: Pick<AccountTarget, 'siteIds'>): boolean {
  if (actor.sites === 'all') return true
  const mine = actor.sites
  return t.siteIds.some(s => mine.includes(s))
}

/** May the actor create, reset, deactivate or reactivate this account? (Visibility is checked first.) */
export function targetManageableBy(actor: Actor, t: Pick<AccountTarget, 'siteIds' | 'adminType'>): boolean {
  if (isFullSuperAdmin(actor)) return true
  if (t.adminType) return false
  if (actor.sites === 'all') return true
  const mine = actor.sites
  return t.siteIds.length > 0 && t.siteIds.every(s => mine.includes(s))
}

/** Why this account is not the actor's to manage, in words that name the owner and the next step. */
export function notYoursToManage(t: Pick<AccountTarget, 'adminType'>, verb: string): Failure {
  return failure('forbidden',
    t.adminType
      ? `This is an administrator account: only a Super Admin can ${verb} this account`
      : `This account also belongs to sites outside yours, so only a Super Admin can ${verb} this account`,
    { owner: 'Super Admin', next: 'Ask a Super Admin to do this' })
}

/**
 * Lock and authorize an account for management (reset, deactivate, reactivate, revoke sessions).
 * Order of refusals: not visible -> 404, visible but not yours to manage -> 403 with owner and next step,
 * your own account -> separation of duties (D-26). `verb` completes "only a Super Admin can <verb> this account" and "You cannot <verb> your own account".
 */
export async function loadManagedAccount(c: CommandContext, userId: string, verb: string): Promise<AccountTarget | Failure> {
  const denied = authorize(c, 'users_roles.manage_staff_accounts')
  if (denied) return denied
  const t = await loadTarget(c.tx, userId, { lock: true })
  if (!t || !targetVisibleTo(c.actor, t)) return fail.notFound()
  if (!targetManageableBy(c.actor, t)) return notYoursToManage(t, verb)
  if (t.id === c.user.id) return fail.sod(`You cannot ${verb} your own account`)
  const self = notSelf(c, t.staffId, 'manage an account')
  if (self) return self
  return t
}

/* ---------------- the last Super Admin (D-27) ---------------- */

const SA_LOCK: [number, number] = [7101, 1]

/**
 * Serialises everything that can take a Super Admin away. Take it BEFORE any row lock in the transaction (a fixed order
 * avoids deadlocks); it is released at commit, and whoever waits then counts again on committed data.
 */
export async function lockSuperAdmins(tx: Tx): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${SA_LOCK[0]}, ${SA_LOCK[1]})`)
}

/** Users who can sign in right now as Super Admin: active account, active global SA assignment. */
export async function activeSuperAdminIds(q: Reader): Promise<string[]> {
  const rows = await q.select({ id: userAccount.id }).from(userAccount)
    .innerJoin(roleAssignment, eq(roleAssignment.userId, userAccount.id))
    .where(and(eq(roleAssignment.role, 'SA'), eq(roleAssignment.scopeKind, 'all'), isNull(roleAssignment.revokedAt),
      eq(userAccount.status, 'active'), isNull(userAccount.revokedAt), isNull(userAccount.archivedAt)))
  return [...new Set(rows.map(r => r.id))]
}

/**
 * A failure when taking Super Admin power away from `userId` (deactivating them or ending their SA assignment) would
 * leave no other active Super Admin. Call lockSuperAdmins(tx) first. Also the hook for Stage 3 (Mark as Left).
 */
export async function lastSuperAdminFailure(tx: Tx, userId: string): Promise<Failure | undefined> {
  const ids = await activeSuperAdminIds(tx)
  if (!ids.includes(userId)) return undefined
  if (ids.some(id => id !== userId)) return undefined
  return failure('conflict', 'This is the last active Super Admin, who can never be removed or deactivated (D-27)', {
    owner: 'Super Admin', next: 'Appoint and activate another Super Admin first, then try again',
  })
}

/* ---------------- credentials ---------------- */

/** A new temporary password and its Argon2id hash. The plaintext goes into the response once and nowhere else. */
export async function newTemporaryCredential(): Promise<{ plain: string; hash: string }> {
  const plain = temporaryPassword()
  return { plain, hash: await hashPassword(plain) }
}
