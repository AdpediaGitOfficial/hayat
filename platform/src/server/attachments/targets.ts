/**
 * What an attachment can hang on. Each package registers its entity types with the rule for who may attach and who
 * may see them, so the permission of the owning record decides (an attachment is never more visible than its record).
 */
import type { Db } from '@/server/db/client'
import type { Actor } from '@/server/policy'

export interface AttachmentTarget {
  entityType: string
  /** Looks the record up. Undefined = it does not exist. Return the site it belongs to (for scope and the audit trail). */
  load(db: Pick<Db, 'select'>, id: string): Promise<{ siteId?: string; ownerStaffId?: string } | undefined>
  canAttach(actor: Actor, rec: { siteId?: string; ownerStaffId?: string }): boolean
  canView(actor: Actor, rec: { siteId?: string; ownerStaffId?: string }): boolean
}

const TARGETS = new Map<string, AttachmentTarget>()
export function registerAttachmentTarget(t: AttachmentTarget): void {
  if (TARGETS.has(t.entityType) && TARGETS.get(t.entityType) !== t) throw new Error(`attachment target ${t.entityType} registered twice`)
  TARGETS.set(t.entityType, t)
}
export const attachmentTarget = (entityType: string) => TARGETS.get(entityType)
export const attachmentTargets = () => [...TARGETS.keys()].sort()
