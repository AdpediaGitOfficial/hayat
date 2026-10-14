/**
 * The checker's inbox (D-27): role changes and capability grants waiting for a decision. Super Admin only
 * (`users_roles.approve_grant`). Each row says whether THIS viewer may decide it: not their own request, not about themselves.
 */
import { asc, eq, inArray } from 'drizzle-orm'
import { getDb } from '@/server/db/client'
import { capabilityGrant, site, staffProfile, userAccount } from '@/server/db/schema'
import { roleChangeRequest } from '@/server/db/schema.access'
import { decide, type Actor } from '@/server/policy'
import type { Capability, Role, ScopeKind } from '@/domain/enums'

export interface PendingRoleChange {
  id: string; kind: 'add' | 'remove'; role: Role; scopeKind: ScopeKind; siteCode: string | null
  targetUserId: string; targetUsername: string; targetName: string | null
  reason: string; makerUsername: string | null; createdAt: string
  mine: boolean; aboutMe: boolean; canDecide: boolean
}
export interface PendingGrant {
  id: string; capability: Capability; targetUserId: string; targetUsername: string; targetName: string | null
  reason: string; startsAt: string; expiresAt: string | null; makerUsername: string | null; createdAt: string
  mine: boolean; aboutMe: boolean; canDecide: boolean
}

export async function listPendingApprovals(actor: Actor, viewerUserId: string): Promise<{ roleChanges: PendingRoleChange[]; grants: PendingGrant[] }> {
  if (!decide(actor, 'users_roles.approve_grant').allowed) return { roleChanges: [], grants: [] }
  const db = getDb()
  const rc = await db.select({ r: roleChangeRequest, siteCode: site.code }).from(roleChangeRequest)
    .leftJoin(site, eq(site.id, roleChangeRequest.siteId)).where(eq(roleChangeRequest.status, 'pending')).orderBy(asc(roleChangeRequest.createdAt)).limit(200)
  const gr = await db.select().from(capabilityGrant).where(eq(capabilityGrant.status, 'pending')).orderBy(asc(capabilityGrant.createdAt)).limit(200)
  const ids = [...new Set([...rc.flatMap(x => [x.r.targetUserId, x.r.makerId]), ...gr.flatMap(g => [g.userId, g.makerId])])]
  const users = ids.length
    ? await db.select({ id: userAccount.id, username: userAccount.username, name: staffProfile.fullName }).from(userAccount)
      .leftJoin(staffProfile, eq(staffProfile.id, userAccount.staffId)).where(inArray(userAccount.id, ids))
    : []
  const by = new Map(users.map(u => [u.id, u]))
  return {
    roleChanges: rc.map(({ r, siteCode }) => {
      const mine = r.makerId === viewerUserId, aboutMe = r.targetUserId === viewerUserId
      return {
        id: r.id, kind: r.kind, role: r.role, scopeKind: r.scopeKind, siteCode, targetUserId: r.targetUserId,
        targetUsername: by.get(r.targetUserId)?.username ?? '?', targetName: by.get(r.targetUserId)?.name ?? null,
        reason: r.reason, makerUsername: by.get(r.makerId)?.username ?? null, createdAt: r.createdAt.toISOString(), mine, aboutMe, canDecide: !mine && !aboutMe,
      }
    }),
    grants: gr.map(g => {
      const mine = g.makerId === viewerUserId, aboutMe = g.userId === viewerUserId
      return {
        id: g.id, capability: g.capability, targetUserId: g.userId, targetUsername: by.get(g.userId)?.username ?? '?', targetName: by.get(g.userId)?.name ?? null,
        reason: g.reason, startsAt: g.startsAt.toISOString(), expiresAt: g.expiresAt?.toISOString() ?? null, makerUsername: by.get(g.makerId)?.username ?? null,
        createdAt: g.createdAt.toISOString(), mine, aboutMe, canDecide: !mine && !aboutMe,
      }
    }),
  }
}
