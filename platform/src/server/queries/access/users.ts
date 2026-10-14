/**
 * User list and detail (WP-C). Visibility: a Super Admin (sites = 'all') sees every account; everyone else with
 * `users_roles.view` (Accommodation Admin, Auditor) sees the accounts that share one of THEIR sites, where an account's
 * sites are the one it was created for plus those of its site-scoped roles. Everything else is simply absent (404).
 * Password hashes are never selected for output.
 */
import { and, asc, count, desc, eq, gt, ilike, inArray, isNull, or, sql, type SQL } from 'drizzle-orm'
import { getDb } from '@/server/db/client'
import { capabilityGrant, roleAssignment, session, site, staffProfile, userAccount } from '@/server/db/schema'
import { accountSite, roleChangeRequest } from '@/server/db/schema.access'
import { decide, scopeFilter, type Actor } from '@/server/policy'
import { scopeSql } from '@/server/queries/scope'
import { accountSiteIds, isAdminType, loadTarget, targetManageableBy, targetVisibleTo } from '@/server/commands/access/guards'
import type { Capability, Role, ScopeKind } from '@/domain/enums'

export interface UserRoleRow { id: string; role: Role; scopeKind: ScopeKind; siteId: string | null; siteCode: string | null; siteName: string | null; buildingId: string | null }
export interface UserListRow {
  id: string
  username: string
  fullName: string | null
  employeeId: string | null
  status: 'invited' | 'active' | 'locked' | 'revoked'
  mustChangePassword: boolean
  lastLoginAt: string | null
  roles: UserRoleRow[]
  /** Capabilities in effect right now. */
  capabilities: Capability[]
  sites: { id: string; code: string; name: string }[]
  /** The viewer's own account: nobody manages their own account (D-26). */
  self: boolean
  /** Whether THIS actor may reset, deactivate or reactivate it. */
  manageable: boolean
}
export interface UserListFilter { q?: string; status?: UserListRow['status']; role?: Role; limit?: number; offset?: number }

const like = (s: string) => `%${s.replace(/[\\%_]/g, m => `\\${m}`)}%`

/** WHERE fragment limiting accounts to the actor's visible sites (undefined = unrestricted, `false` = nothing). */
function visibility(actor: Actor): SQL | undefined {
  const f = scopeFilter(actor, 'users_roles.view')
  const a = scopeSql(f, { site: accountSite.siteId })
  if (a === undefined) return undefined
  const b = scopeSql(f, { site: roleAssignment.siteId })
  return or(
    sql`exists (select 1 from ${accountSite} where ${accountSite.userId} = ${userAccount.id} and ${accountSite.archivedAt} is null and ${a})`,
    sql`exists (select 1 from ${roleAssignment} where ${roleAssignment.userId} = ${userAccount.id} and ${roleAssignment.revokedAt} is null and ${b})`,
  )
}

async function rolesFor(userIds: string[]): Promise<Map<string, UserRoleRow[]>> {
  const out = new Map<string, UserRoleRow[]>()
  if (userIds.length === 0) return out
  const rows = await getDb().select({
    userId: roleAssignment.userId, id: roleAssignment.id, role: roleAssignment.role, scopeKind: roleAssignment.scopeKind,
    siteId: roleAssignment.siteId, siteCode: site.code, siteName: site.name, buildingId: roleAssignment.buildingId,
  }).from(roleAssignment).leftJoin(site, eq(site.id, roleAssignment.siteId))
    .where(and(inArray(roleAssignment.userId, userIds), isNull(roleAssignment.revokedAt))).orderBy(asc(roleAssignment.createdAt))
  for (const r of rows) {
    const list = out.get(r.userId) ?? []
    list.push({ id: r.id, role: r.role, scopeKind: r.scopeKind, siteId: r.siteId, siteCode: r.siteCode, siteName: r.siteName, buildingId: r.buildingId })
    out.set(r.userId, list)
  }
  return out
}

async function activeCaps(userIds: string[], now: Date): Promise<Map<string, Capability[]>> {
  const out = new Map<string, Capability[]>()
  if (userIds.length === 0) return out
  const rows = await getDb().select({ userId: capabilityGrant.userId, capability: capabilityGrant.capability }).from(capabilityGrant).where(and(
    inArray(capabilityGrant.userId, userIds), eq(capabilityGrant.status, 'active'), isNull(capabilityGrant.revokedAt),
    sql`${capabilityGrant.startsAt} <= ${now}`, or(isNull(capabilityGrant.expiresAt), gt(capabilityGrant.expiresAt, now)),
  ))
  for (const r of rows) {
    const list = out.get(r.userId) ?? []
    if (!list.includes(r.capability)) list.push(r.capability)
    out.set(r.userId, list)
  }
  return out
}

export async function listUsers(actor: Actor, filter: UserListFilter, now: Date, viewerUserId?: string): Promise<{ rows: UserListRow[]; hasMore: boolean }> {
  if (!decide(actor, 'users_roles.view').allowed || scopeFilter(actor, 'users_roles.view').kind === 'none') return { rows: [], hasMore: false }
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200)
  const where = and(
    visibility(actor),
    filter.status ? eq(userAccount.status, filter.status) : undefined,
    filter.role ? sql`exists (select 1 from ${roleAssignment} where ${roleAssignment.userId} = ${userAccount.id} and ${roleAssignment.revokedAt} is null and ${roleAssignment.role} = ${filter.role})` : undefined,
    filter.q?.trim() ? or(ilike(userAccount.username, like(filter.q.trim())), ilike(staffProfile.fullName, like(filter.q.trim())), ilike(staffProfile.employeeId, like(filter.q.trim()))) : undefined,
  )
  const base = await getDb().select({
    id: userAccount.id, username: userAccount.username, status: userAccount.status, mustChangePassword: userAccount.mustChangePassword,
    lastLoginAt: userAccount.lastLoginAt, fullName: staffProfile.fullName, employeeId: staffProfile.employeeId,
  }).from(userAccount).leftJoin(staffProfile, eq(staffProfile.id, userAccount.staffId))
    .where(where).orderBy(asc(sql`lower(${userAccount.username})`), asc(userAccount.id)).limit(limit + 1).offset(filter.offset ?? 0)
  const page = base.slice(0, limit)
  const ids = page.map(r => r.id)
  const [roles, caps, siteMap] = await Promise.all([rolesFor(ids), activeCaps(ids, now), accountSiteIds(getDb(), ids)])
  const allSiteIds = [...new Set([...siteMap.values()].flat())]
  const siteRows = allSiteIds.length ? await getDb().select({ id: site.id, code: site.code, name: site.name }).from(site).where(inArray(site.id, allSiteIds)) : []
  const siteById = new Map(siteRows.map(s => [s.id, s]))
  const rows: UserListRow[] = page.map(r => {
    const rs = roles.get(r.id) ?? []
    const siteIds = siteMap.get(r.id) ?? []
    return {
      id: r.id, username: r.username, fullName: r.fullName, employeeId: r.employeeId, status: r.status, mustChangePassword: r.mustChangePassword,
      lastLoginAt: r.lastLoginAt?.toISOString() ?? null, roles: rs, capabilities: caps.get(r.id) ?? [],
      sites: siteIds.map(id => siteById.get(id)).filter((s): s is NonNullable<typeof s> => !!s),
      self: r.id === viewerUserId,
      manageable: r.id !== viewerUserId && decide(actor, 'users_roles.manage_staff_accounts').allowed && targetManageableBy(actor, { siteIds, adminType: isAdminType(rs) }),
    }
  })
  return { rows, hasMore: base.length > limit }
}

export type GrantState = 'pending' | 'scheduled' | 'active' | 'expired' | 'rejected' | 'revoked'
export interface UserGrantRow {
  id: string; capability: Capability; reason: string; state: GrantState
  startsAt: string; expiresAt: string | null; makerUsername: string | null; checkerUsername: string | null; createdAt: string; decidedAt: string | null
}
export interface UserRequestRow {
  id: string; kind: 'add' | 'remove'; role: Role; scopeKind: ScopeKind; siteCode: string | null; reason: string; status: string
  makerUsername: string | null; checkerUsername: string | null; createdAt: string; decidedAt: string | null; decisionNote: string | null
}
export interface UserSessionRow { id: string; createdAt: string; lastSeenAt: string; ip: string | null; userAgent: string | null; activeRole: Role | null }
export interface UserDetail {
  self: boolean
  id: string
  username: string
  fullName: string | null
  employeeId: string | null
  employmentStatus: 'active' | 'left' | null
  status: UserListRow['status']
  mustChangePassword: boolean
  lockedUntil: string | null
  lastLoginAt: string | null
  createdAt: string
  roles: UserRoleRow[]
  sites: { id: string; code: string; name: string }[]
  grants: UserGrantRow[]
  roleChanges: UserRequestRow[]
  liveSessions: UserSessionRow[]
  liveSessionCount: number
  manageable: boolean
  /** Why not, when `manageable` is false, so the page can say who to ask. */
  notManageableReason?: string
  canManageRoles: boolean
  canDecideGrants: boolean
}

export function grantState(g: { status: string; startsAt: Date; expiresAt: Date | null; revokedAt: Date | null }, now: Date): GrantState {
  if (g.status === 'pending') return 'pending'
  if (g.status === 'rejected') return 'rejected'
  if (g.status === 'revoked' || g.revokedAt) return 'revoked'
  if (g.expiresAt && g.expiresAt.getTime() <= now.getTime()) return 'expired'
  if (g.startsAt.getTime() > now.getTime()) return 'scheduled'
  return 'active'
}

export async function getUserDetail(actor: Actor, userId: string, now: Date, viewerUserId?: string): Promise<UserDetail | undefined> {
  if (!decide(actor, 'users_roles.view').allowed) return undefined
  const db = getDb()
  const t = await loadTarget(db, userId)
  if (!t || !targetVisibleTo(actor, t)) return undefined
  const [u] = await db.select({ createdAt: userAccount.createdAt }).from(userAccount).where(eq(userAccount.id, userId))
  const roles = (await rolesFor([userId])).get(userId) ?? []
  const siteRows = t.siteIds.length ? await db.select({ id: site.id, code: site.code, name: site.name }).from(site).where(inArray(site.id, t.siteIds)) : []

  const nameOf = async (ids: (string | null)[]) => {
    const real = [...new Set(ids.filter((x): x is string => !!x))]
    const rows = real.length ? await db.select({ id: userAccount.id, username: userAccount.username }).from(userAccount).where(inArray(userAccount.id, real)) : []
    return new Map(rows.map(r => [r.id, r.username]))
  }
  const grantRows = await db.select().from(capabilityGrant).where(eq(capabilityGrant.userId, userId)).orderBy(desc(capabilityGrant.createdAt)).limit(50)
  const requestRows = await db.select({ r: roleChangeRequest, siteCode: site.code }).from(roleChangeRequest)
    .leftJoin(site, eq(site.id, roleChangeRequest.siteId)).where(eq(roleChangeRequest.targetUserId, userId)).orderBy(desc(roleChangeRequest.createdAt)).limit(50)
  const names = await nameOf([...grantRows.flatMap(g => [g.makerId, g.checkerId]), ...requestRows.flatMap(x => [x.r.makerId, x.r.checkerId])])

  const sessions = await db.select().from(session).where(and(eq(session.userId, userId), isNull(session.revokedAt), gt(session.expiresAt, now)))
    .orderBy(desc(session.lastSeenAt)).limit(10)
  const [{ n }] = await db.select({ n: count() }).from(session).where(and(eq(session.userId, userId), isNull(session.revokedAt), gt(session.expiresAt, now)))

  const mayManageAccounts = decide(actor, 'users_roles.manage_staff_accounts').allowed
  const self = t.id === viewerUserId
  const manageable = !self && mayManageAccounts && targetManageableBy(actor, t)
  return {
    self,
    id: t.id, username: t.username, fullName: t.fullName, employeeId: t.employeeId, employmentStatus: t.employmentStatus, status: t.status,
    mustChangePassword: t.mustChangePassword, lockedUntil: t.lockedUntil && t.lockedUntil > now ? t.lockedUntil.toISOString() : null,
    lastLoginAt: t.lastLoginAt?.toISOString() ?? null, createdAt: u.createdAt.toISOString(), roles, sites: siteRows,
    grants: grantRows.map(g => ({
      id: g.id, capability: g.capability, reason: g.reason, state: grantState(g, now), startsAt: g.startsAt.toISOString(), expiresAt: g.expiresAt?.toISOString() ?? null,
      makerUsername: names.get(g.makerId) ?? null, checkerUsername: g.checkerId ? names.get(g.checkerId) ?? null : null, createdAt: g.createdAt.toISOString(), decidedAt: g.decidedAt?.toISOString() ?? null,
    })),
    roleChanges: requestRows.map(({ r, siteCode }) => ({
      id: r.id, kind: r.kind, role: r.role, scopeKind: r.scopeKind, siteCode, reason: r.reason, status: r.status,
      makerUsername: names.get(r.makerId) ?? null, checkerUsername: r.checkerId ? names.get(r.checkerId) ?? null : null,
      createdAt: r.createdAt.toISOString(), decidedAt: r.decidedAt?.toISOString() ?? null, decisionNote: r.decisionNote,
    })),
    liveSessions: sessions.map(s => ({ id: s.id, createdAt: s.createdAt.toISOString(), lastSeenAt: s.lastSeenAt.toISOString(), ip: s.ip, userAgent: s.userAgent, activeRole: s.activeRole })),
    liveSessionCount: n,
    manageable,
    notManageableReason: manageable ? undefined : self ? 'This is your own account: a different administrator has to do this (D-26)' : !mayManageAccounts ? 'Your role can view accounts but not change them' : t.adminType ? 'Administrator account: only a Super Admin can change it' : 'The account also belongs to sites outside yours: only a Super Admin can change it',
    canManageRoles: decide(actor, 'users_roles.manage_roles_and_scope').allowed,
    canDecideGrants: decide(actor, 'users_roles.approve_grant').allowed,
  }
}
