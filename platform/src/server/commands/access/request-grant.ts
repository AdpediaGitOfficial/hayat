import { z } from 'zod'
import { and, eq, gt, inArray, isNull, or } from 'drizzle-orm'
import { capabilityGrant } from '@/server/db/schema'
import { audit } from '@/server/audit'
import { authorize } from '@/server/command/authorize'
import { runCommand } from '@/server/command/run'
import { fail, failure, ok, type Result } from '@/server/command/result'
import type { RequestContext } from '@/server/command/context'
import { CAPABILITIES, type Capability } from '@/domain/enums'
import { CAP_LABEL } from '@/domain/labels'
import { loadTarget } from './guards'

const when = z.iso.datetime({ offset: true })
export const input = z.object({
  userId: z.uuid(),
  capability: z.enum(CAPABILITIES),
  reason: z.string().trim().min(1, 'Say why').max(500),
  /** Defaults to now. A later start keeps the grant dormant until then. */
  startsAt: when.optional(),
  /** Optional: a grant without one stays until revoked. */
  expiresAt: when.optional(),
})
export type Input = z.infer<typeof input>
export interface Output { grantId: string; warnings: string[] }

/** Capabilities whose actions are limited by the holder's own sites (everything except the job-scoped Housekeeping). */
const NEEDS_SITES: readonly Capability[] = CAPABILITIES.filter(k => k !== 'Housekeeping')

/**
 * Maker step for a capability grant (D-22, D-27). A grant adds ACTIONS, never scope: whatever it allows, the holder
 * still acts only inside the sites their own role assignments give them. No particular base role is required (the
 * policy gives a capability to an actor of any role), but the person must hold at least one active role, and the
 * response warns when they have no site for a site-scoped capability to work in.
 */
export async function requestGrant(rc: RequestContext, raw: Input): Promise<Result<Output>> {
  return runCommand(rc, async c => {
    const denied = authorize(c, 'users_roles.manage_roles_and_scope')
    if (denied) return denied
    const target = await loadTarget(c.tx, raw.userId, { lock: true })
    if (!target) return fail.notFound()
    if (target.revokedAt || target.archivedAt || target.status === 'revoked') {
      return failure('conflict', 'This account is deactivated', { owner: 'Accommodation Admin or Super Admin', next: 'Reactivate the account first' })
    }
    if (target.assignments.length === 0) {
      return failure('conflict', 'This person holds no role yet, so a capability would have nothing to add to', { owner: 'Super Admin', next: 'Request and approve a role first' })
    }
    const now = c.now
    const startsAt = raw.startsAt ? new Date(Math.max(Date.parse(raw.startsAt), now.getTime())) : now
    const expiresAt = raw.expiresAt ? new Date(raw.expiresAt) : null
    if (expiresAt && expiresAt.getTime() <= now.getTime()) return fail.invalid('The end date is already past', { expiresAt: 'Choose a time in the future' })
    if (expiresAt && expiresAt.getTime() <= startsAt.getTime()) return fail.invalid('The grant must end after it starts', { expiresAt: 'Choose a time after the start' })

    const [dup] = await c.tx.select({ id: capabilityGrant.id, status: capabilityGrant.status }).from(capabilityGrant).where(and(
      eq(capabilityGrant.userId, target.id), eq(capabilityGrant.capability, raw.capability), inArray(capabilityGrant.status, ['pending', 'active']),
      isNull(capabilityGrant.revokedAt), or(isNull(capabilityGrant.expiresAt), gt(capabilityGrant.expiresAt, now)),
    )).limit(1)
    if (dup) {
      return failure('conflict', dup.status === 'pending' ? 'The same grant is already waiting for approval' : 'The person already holds this capability', {
        owner: 'Super Admin', next: dup.status === 'pending' ? 'Ask another Super Admin to decide the pending request' : 'Revoke the current grant first if the terms should change',
      })
    }

    const [row] = await c.tx.insert(capabilityGrant).values({
      userId: target.id, capability: raw.capability, reason: raw.reason, startsAt, expiresAt, status: 'pending', makerId: c.user.id, createdAt: now,
    }).returning({ id: capabilityGrant.id })

    const warnings: string[] = []
    if (NEEDS_SITES.includes(raw.capability) && !target.assignments.some(a => a.scopeKind === 'all' || a.scopeKind === 'site')) {
      warnings.push(`${CAP_LABEL[raw.capability]} adds actions only. This person has no site scope, so it will have no effect until a Super Admin gives them a site.`)
    }
    await audit(c, {
      action: 'access.grant.requested', entityType: 'capability_grant', entityId: row.id, reason: raw.reason,
      after: { targetUserId: target.id, targetUsername: target.username, capability: raw.capability, startsAt: startsAt.toISOString(), expiresAt: expiresAt?.toISOString() ?? null },
    })
    return ok({ grantId: row.id, warnings }, 'Sent for approval. A different Super Admin must approve it before it takes effect')
  })
}
