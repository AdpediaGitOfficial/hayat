/**
 * Turns a user's role assignments and capability grants into the Actor the policy module evaluates (S-2):
 * ONE active mode per session. Capability grants add actions, never scope (D-22), and a building-scoped
 * assignment gives no site scope (S-6): the actor's `sites` is only ever built from site/all assignments.
 */
import { and, eq, gt, isNull, lte, or } from 'drizzle-orm'
import { capabilityGrant, roleAssignment } from '@/server/db/schema'
import type { Db } from '@/server/db/client'
import type { Capability, Role } from '@/domain/enums'
import type { Actor } from '@/server/policy'

export interface Assignment { id: string; role: Role; scopeKind: 'all' | 'site' | 'building' | 'own' | 'job'; siteId: string | null; buildingId: string | null }
export interface Access { assignments: Assignment[]; caps: Capability[] }

/** Default mode when nothing was chosen: most powerful first, resident last. */
const MODE_ORDER: readonly Role[] = ['SA', 'AA', 'Rec', 'MC', 'Sec', 'Mgr', 'Aud', 'Tech', 'Vend', 'Res']

export async function loadAccess(q: Pick<Db, 'select'>, userId: string, now: Date): Promise<Access> {
  const assignments = await q.select({
    id: roleAssignment.id, role: roleAssignment.role, scopeKind: roleAssignment.scopeKind,
    siteId: roleAssignment.siteId, buildingId: roleAssignment.buildingId,
  }).from(roleAssignment).where(and(eq(roleAssignment.userId, userId), isNull(roleAssignment.revokedAt)))
  const grants = await q.select({ capability: capabilityGrant.capability }).from(capabilityGrant).where(and(
    eq(capabilityGrant.userId, userId), eq(capabilityGrant.status, 'active'), isNull(capabilityGrant.revokedAt),
    lte(capabilityGrant.startsAt, now), or(isNull(capabilityGrant.expiresAt), gt(capabilityGrant.expiresAt, now)),
  ))
  return { assignments, caps: [...new Set(grants.map(g => g.capability))] }
}

/** The modes a user may switch between, in a stable order. */
export function availableModes(access: Access): Role[] {
  const held = new Set(access.assignments.map(a => a.role))
  return MODE_ORDER.filter(r => held.has(r))
}

/** The requested mode if the user still holds it, else the first available one; undefined if they hold no role. */
export function chooseMode(access: Access, requested?: Role | null): Role | undefined {
  const modes = availableModes(access)
  return requested && modes.includes(requested) ? requested : modes[0]
}

export function buildActor(access: Access, role: Role, staffId?: string): Actor {
  const mine = access.assignments.filter(a => a.role === role)
  const sites: string[] | 'all' = mine.some(a => a.scopeKind === 'all')
    ? 'all'
    : [...new Set(mine.filter(a => a.scopeKind === 'site' && a.siteId).map(a => a.siteId!))]
  return { role, caps: access.caps, sites, staffId }
}
