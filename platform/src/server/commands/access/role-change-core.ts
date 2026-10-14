/**
 * The maker half of a role change, shared by requestRoleChange and createAccount (which can file the first role
 * request in the same transaction). Nothing here changes anyone's access: it only records a pending request (D-27).
 */
import { and, eq, isNull } from 'drizzle-orm'
import { building, site } from '@/server/db/schema'
import { roleChangeRequest } from '@/server/db/schema.access'
import { audit } from '@/server/audit'
import type { CommandContext } from '@/server/command/context'
import { fail, failure, type Failure } from '@/server/command/result'
import { ROLE_LABEL } from '@/domain/labels'
import type { Role, ScopeKind } from '@/domain/enums'
import { ROLE_SCOPE_KINDS, lastSuperAdminFailure, type AccountTarget } from './guards'

export interface RoleSpec { role: Role; scopeKind: ScopeKind; siteId?: string | null; buildingId?: string | null }

/** A scope the role can't have, or a site/building that doesn't exist, as a form error. */
export async function checkRoleSpec(c: CommandContext, s: RoleSpec): Promise<Failure | undefined> {
  if (!ROLE_SCOPE_KINDS[s.role].includes(s.scopeKind)) {
    const allowed = ROLE_SCOPE_KINDS[s.role].join(' / ')
    return fail.invalid(`${ROLE_LABEL[s.role]} can only have this scope: ${allowed}`, { scopeKind: `Choose ${allowed}` })
  }
  if (s.scopeKind === 'site') {
    if (!s.siteId) return fail.invalid('Choose the site', { siteId: 'Required for a site scope' })
    const [row] = await c.tx.select({ id: site.id }).from(site).where(and(eq(site.id, s.siteId), isNull(site.archivedAt)))
    if (!row) return fail.invalid('That site does not exist or is archived', { siteId: 'Choose an active site' })
  } else if (s.siteId) {
    return fail.invalid('A site only goes with a site scope', { siteId: 'Remove the site or choose the site scope' })
  }
  if (s.scopeKind === 'building') {
    if (!s.buildingId) return fail.invalid('Choose the building', { buildingId: 'Required for a building scope' })
    const [row] = await c.tx.select({ id: building.id }).from(building).where(and(eq(building.id, s.buildingId), isNull(building.archivedAt)))
    if (!row) return fail.invalid('That building does not exist or is archived', { buildingId: 'Choose an active building' })
  } else if (s.buildingId) {
    return fail.invalid('A building only goes with a building scope', { buildingId: 'Remove the building or choose the building scope' })
  }
  return undefined
}

export const BUILDING_SCOPE_NOTE =
  'A building scope gives no site scope yet (S-6): the person will not see any site-level data through it until a site scope is added.'

const sameSpec = (a: { role: Role; scopeKind: ScopeKind; siteId: string | null; buildingId: string | null }, b: RoleSpec) =>
  a.role === b.role && a.scopeKind === b.scopeKind && (a.siteId ?? null) === (b.siteId ?? null) && (a.buildingId ?? null) === (b.buildingId ?? null)

export type FileRoleChange =
  | { kind: 'add'; spec: RoleSpec; reason: string }
  | { kind: 'remove'; assignmentId: string; reason: string }

export interface FiledRoleChange { id: string; warnings: string[] }

/** Validates and inserts a pending request. `target` must be loaded (and locked) by the caller. */
export async function fileRoleChange(c: CommandContext, target: AccountTarget, req: FileRoleChange): Promise<FiledRoleChange | Failure> {
  if (target.revokedAt || target.archivedAt || target.status === 'revoked') {
    return failure('conflict', 'This account is deactivated', { owner: 'Accommodation Admin or Super Admin', next: 'Reactivate the account first, then request the role change' })
  }
  const warnings: string[] = []
  let spec: RoleSpec
  let assignmentId: string | null = null
  if (req.kind === 'add') {
    spec = req.spec
    const bad = await checkRoleSpec(c, spec)
    if (bad) return bad
    if (target.assignments.some(a => sameSpec(a, spec))) {
      return failure('conflict', `${target.fullName ?? target.username} already holds this role with this scope`, { owner: 'Super Admin', next: 'Nothing to do, or pick a different scope' })
    }
    if (spec.scopeKind === 'building') warnings.push(BUILDING_SCOPE_NOTE)
  } else {
    const a = target.assignments.find(x => x.id === req.assignmentId)
    if (!a) return fail.notFound()
    spec = { role: a.role, scopeKind: a.scopeKind, siteId: a.siteId, buildingId: a.buildingId }
    assignmentId = a.id
    if (a.role === 'SA') {
      // Early, friendly refusal. The decisive check runs again under the lock when the second Super Admin approves.
      const last = await lastSuperAdminFailure(c.tx, target.id)
      if (last) return last
    }
    if (target.assignments.length === 1) warnings.push('This is their only role: they will not be able to sign in until another one is assigned.')
  }

  const pendingDup = await c.tx.select({ id: roleChangeRequest.id }).from(roleChangeRequest).where(and(
    eq(roleChangeRequest.targetUserId, target.id), eq(roleChangeRequest.status, 'pending'), eq(roleChangeRequest.kind, req.kind),
    eq(roleChangeRequest.role, spec.role), eq(roleChangeRequest.scopeKind, spec.scopeKind),
    spec.siteId ? eq(roleChangeRequest.siteId, spec.siteId) : isNull(roleChangeRequest.siteId),
    spec.buildingId ? eq(roleChangeRequest.buildingId, spec.buildingId) : isNull(roleChangeRequest.buildingId),
    assignmentId ? eq(roleChangeRequest.assignmentId, assignmentId) : isNull(roleChangeRequest.assignmentId),
  )).limit(1)
  if (pendingDup.length) {
    return failure('conflict', 'The same change is already waiting for approval', { owner: 'A second Super Admin', next: 'Ask another Super Admin to decide the pending request' })
  }

  const [row] = await c.tx.insert(roleChangeRequest).values({
    targetUserId: target.id, kind: req.kind, role: spec.role, scopeKind: spec.scopeKind,
    siteId: spec.siteId ?? null, buildingId: spec.buildingId ?? null, assignmentId,
    reason: req.reason.trim(), makerId: c.user.id,
  }).returning({ id: roleChangeRequest.id })
  await audit(c, {
    action: 'access.role_change.requested', entityType: 'role_change_request', entityId: row.id, siteId: spec.siteId ?? undefined, reason: req.reason.trim(),
    after: { targetUserId: target.id, targetUsername: target.username, kind: req.kind, role: spec.role, scopeKind: spec.scopeKind, siteId: spec.siteId ?? null, buildingId: spec.buildingId ?? null, assignmentId },
  })
  return { id: row.id, warnings }
}

