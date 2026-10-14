/**
 * Evidence on a cleaning task: photos of damage noticed while cleaning, or of what failed an inspection.
 * The permission of the task decides: who may see it (SA, Reception, Maintenance Coordinator, Auditor, the housekeeper it is
 * assigned to, Final Inspection holders of the site) and who may add to it (whoever may complete or inspect it).
 * Imported once from the WP-J block of `src/server/attachments/targets.index.ts`.
 */
import { eq } from 'drizzle-orm'
import { cleaningTask } from '@/server/db/schema.stage3'
import { registerAttachmentTarget } from '@/server/attachments/targets'
import { can, type Actor } from '@/server/policy'

type Rec = { siteId?: string; ownerStaffId?: string }
/** `ownerStaffId` carries the ASSIGNED HOUSEKEEPER of the task here (the target interface has no separate field). */
const asResource = (r: Rec) => ({ siteId: r.siteId, assigneeStaffId: r.ownerStaffId })

const mayInspect = (a: Actor, r: Rec) => can(a, 'housekeeping_readiness.final_inspection', asResource(r))
const mayClean = (a: Actor, r: Rec) => can(a, 'housekeeping_readiness.clean', asResource(r))

registerAttachmentTarget({
  entityType: 'cleaning_task',
  async load(db, id) {
    const [t] = await db.select({ siteId: cleaningTask.siteId, assignee: cleaningTask.assignedToStaff }).from(cleaningTask).where(eq(cleaningTask.id, id)).limit(1)
    return t ? { siteId: t.siteId, ownerStaffId: t.assignee ?? undefined } : undefined
  },
  canAttach: (a, r) => mayClean(a, r) || mayInspect(a, r),
  // The Manager sees a summary only (PERMISSIONS), never the evidence.
  canView: (a, r) => (['SA', 'Rec', 'MC', 'Aud'].includes(a.role) && can(a, 'housekeeping_readiness.view', asResource(r))) || mayInspect(a, r) || mayClean(a, r),
})
