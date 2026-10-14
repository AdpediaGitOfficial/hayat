import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { capabilityGrant } from '@/server/db/schema'
import { audit } from '@/server/audit'
import { authorize } from '@/server/command/authorize'
import { runCommand } from '@/server/command/run'
import { fail, failure, ok, type Result } from '@/server/command/result'
import type { RequestContext } from '@/server/command/context'

export const input = z.object({ grantId: z.uuid(), reason: z.string().trim().min(1, 'Say why').max(500) })
export type Input = z.infer<typeof input>
export const body = input.omit({ grantId: true })
export interface Output { grantId: string; was: 'pending' | 'active' }

/**
 * Takes a capability away at once (or withdraws a request still waiting). Removing power needs no second person: any
 * Super Admin may do it, including the one who filed the grant. It is audited with the reason. The actor is rebuilt
 * from the database on every request, so the holder loses the actions on their next click.
 */
export async function revokeGrant(rc: RequestContext, raw: Input): Promise<Result<Output>> {
  return runCommand(rc, async c => {
    const denied = authorize(c, 'users_roles.approve_grant')
    if (denied) return denied
    const [g] = await c.tx.select().from(capabilityGrant).where(eq(capabilityGrant.id, raw.grantId)).limit(1).for('update')
    if (!g) return fail.notFound()
    if (g.status !== 'pending' && g.status !== 'active') return failure('conflict', `This grant is already ${g.status}`, { owner: 'Super Admin', next: 'Nothing to do' })
    await c.tx.update(capabilityGrant).set({ status: 'revoked', revokedAt: c.now }).where(eq(capabilityGrant.id, g.id))
    await audit(c, {
      action: 'access.grant.revoked', entityType: 'capability_grant', entityId: g.id, reason: raw.reason,
      before: { status: g.status }, after: { status: 'revoked', targetUserId: g.userId, capability: g.capability },
    })
    return ok({ grantId: g.id, was: g.status }, g.status === 'pending' ? 'Request withdrawn' : 'Capability revoked. It stops working on their next action')
  })
}
