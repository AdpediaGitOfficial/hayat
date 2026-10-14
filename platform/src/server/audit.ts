import { auditEvent } from '@/server/db/schema'
import type { CommandContext } from '@/server/command/context'

export interface AuditInput {
  /** Dotted verb, e.g. 'property.bed.blocked'. */
  action: string
  entityType?: string
  entityId?: string
  /** Lets "audit log: own sites" be scoped in SQL. */
  siteId?: string
  reason?: string
  before?: unknown
  after?: unknown
}

/** Writes the audit event inside the command's transaction, so a rolled-back command leaves no audit row either. */
export async function audit(c: CommandContext, e: AuditInput): Promise<void> {
  await c.tx.insert(auditEvent).values({
    actorUserId: c.user.id,
    actorRole: c.actor.role,
    action: e.action,
    entityType: e.entityType ?? null,
    entityId: e.entityId ?? null,
    siteId: e.siteId ?? null,
    reason: e.reason ?? null,
    before: e.before ?? null,
    after: e.after ?? null,
    requestId: c.requestId,
    ip: c.ip ?? null,
  })
}
