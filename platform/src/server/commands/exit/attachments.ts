/**
 * Evidence on a clearance item (a waiver's proof, a photo of the room). The permission of the owning case decides:
 *   view    Super Admin, Accommodation Admin, Reception, Maintenance Coordinator, Auditor of the case's site, and the Policy Approver
 *           who has to decide a waiver (not the Manager role, which sees the case but not the files)
 *   attach  whoever may complete or waive the item
 * Importing this file registers the target (one line in src/server/attachments/targets.index.ts).
 */
import { eq } from 'drizzle-orm'
import { clearanceCase, clearanceItem } from '@/server/db/schema.exit'
import { registerAttachmentTarget } from '@/server/attachments/targets'
import { decide, scopeFilter, type Action, type Actor } from '@/server/policy'

interface Rec { siteId?: string; ownerStaffId?: string }

/** The action at the case's site; a case with no site is open to any holder of the action with a usable scope (S-8). */
function may(actor: Actor, action: Action, rec: Rec): boolean {
  if (rec.siteId) return decide(actor, action, { siteId: rec.siteId }).allowed
  return decide(actor, action).allowed && scopeFilter(actor, action).kind !== 'none'
}

const VIEW_ROLES = ['SA', 'AA', 'Rec', 'MC', 'Aud']

registerAttachmentTarget({
  entityType: 'clearance_item',
  async load(db, id) {
    const [r] = await db.select({ siteId: clearanceCase.siteId, ownerStaffId: clearanceCase.staffId }).from(clearanceItem)
      .innerJoin(clearanceCase, eq(clearanceCase.id, clearanceItem.caseId)).where(eq(clearanceItem.id, id)).limit(1)
    return r ? { siteId: r.siteId ?? undefined, ownerStaffId: r.ownerStaffId } : undefined
  },
  canAttach: (actor, rec) => (may(actor, 'exit_clearance.clearance_task', rec) || may(actor, 'exit_clearance.inspection_item', rec) || may(actor, 'exit_clearance.waive', rec)) && actor.staffId !== rec.ownerStaffId,
  canView: (actor, rec) => (VIEW_ROLES.includes(actor.role) && may(actor, 'exit_clearance.view', rec)) || may(actor, 'exit_clearance.waive', rec),
})
