/**
 * Evidence for lost and damaged keys and assets (WP-I): files hang on the item (`handover_item`) and are seen by whoever may
 * see the item, so an attachment is never more visible than its record. The holder sees what is attached to their own item.
 */
import { eq } from 'drizzle-orm'
import { handoverItem } from '@/server/db/schema.stage3'
import { registerAttachmentTarget } from '@/server/attachments/targets'
import { can } from '@/server/policy'
import { KEY_ACTIONS, MOVE_ACTIONS } from './shared'

registerAttachmentTarget({
  entityType: 'handover_item',
  async load(db, id) {
    const [r] = await db.select({ siteId: handoverItem.siteId, holder: handoverItem.holderStaffId }).from(handoverItem).where(eq(handoverItem.id, id)).limit(1)
    return r ? { siteId: r.siteId, ownerStaffId: r.holder ?? undefined } : undefined
  },
  canView: (actor, rec) => KEY_ACTIONS.some(a => can(actor, a, rec)),
  canAttach: (actor, rec) => MOVE_ACTIONS.some(a => can(actor, a, rec)),
})
