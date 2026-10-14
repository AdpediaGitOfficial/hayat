/**
 * Final inspection (D-24, D-64, SRS 12.54). A Final Inspection holder passes or fails a cleaned bed.
 *
 *  - PASS is the ONLY place in the code that moves a bed from Inspection required to Available. `tests/api/readiness/boundary.test.ts`
 *    greps `src` and `app` and fails the build if any other file writes `state: 'available'` on a bed.
 *    It also tells the Accommodation Admin who is next in the waitlist for the freed bed. It does NOT create an offer (D-108).
 *  - FAIL needs a note, returns the bed to Needs cleaning and opens a fresh cleaning task; the housekeeper is told what to redo.
 *
 * The inspector is never the cleaner and never lives in that room (D-26). Refused with `separation_of_duties`; the database check
 * `cleaning_cleaner_not_inspector` is the second line of defence.
 */
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { bed } from '@/server/db/schema'
import { cleaningTask } from '@/server/db/schema.stage3'
import { audit } from '@/server/audit'
import { authorize } from '@/server/command/authorize'
import { runCommand } from '@/server/command/run'
import type { CommandContext, RequestContext } from '@/server/command/context'
import { fail, ok, type Failure, type Result } from '@/server/command/result'
import { notify } from '@/server/notify'
import { notifyFreedBed } from '@/server/commands/waitlist/queue'
import { openCleaningTask } from '@/server/readiness/hooks'
import { checkAttachments, idSchema, livesInRoom, loadTaskLocked, noteSchema, ownRoom, wrongBedState, wrongStage, type TaskCtx } from './shared'

/** Everything both outcomes need to be true. Returns the context, or the failure to hand back. */
async function loadForInspection(c: CommandContext, taskId: string): Promise<TaskCtx | Failure> {
  const t = await loadTaskLocked(c.tx, taskId)
  if (!t) return fail.notFound()
  const denied = authorize(c, 'housekeeping_readiness.final_inspection', { siteId: t.task.siteId })
  if (denied) return denied
  const me = c.actor.staffId
  if (!me) return fail.forbidden('inspect without a staff record')
  if (t.task.status !== 'cleaned') return wrongStage(t.task, 'cleaned')
  if (t.bed.state !== 'inspection_required') return wrongBedState(t.bed, 'inspection_required')
  if (t.task.cleanedByStaff === me) return fail.sod('You cleaned this room, so you cannot inspect it', 'Another Final Inspection holder inspects it (D-26)')
  if (await livesInRoom(c.tx, me, t.roomId)) return ownRoom(t.roomName, 'inspect')
  return t
}
const isFailure = (x: TaskCtx | Failure): x is Failure => 'ok' in x

/* ---------------- pass ---------------- */

export const passInput = z.object({ taskId: idSchema, note: noteSchema })
export type PassInspectionInput = z.infer<typeof passInput>
export interface PassInspectionOut { taskId: string; bedId: string; bedState: 'available'; nextInQueueNotified: boolean }

export function passInspection(rc: RequestContext, i: PassInspectionInput): Promise<Result<PassInspectionOut>> {
  return runCommand(rc, async c => {
    const t = await loadForInspection(c, i.taskId)
    if (isFailure(t)) return t
    await c.tx.update(cleaningTask).set({ status: 'passed', inspectedByStaff: c.actor.staffId!, inspectedBy: c.user.id, inspectedAt: c.now, inspectionNote: i.note }).where(eq(cleaningTask.id, t.task.id))
    // The one and only writer of Inspection required -> Available (D-64).
    await c.tx.update(bed).set({ state: 'available', stateReason: null, stateSince: c.now }).where(eq(bed.id, t.bed.id))
    await audit(c, {
      action: 'readiness.inspection.passed', entityType: 'cleaning_task', entityId: t.task.id, siteId: t.task.siteId, reason: i.note ?? undefined,
      before: { status: 'cleaned', bed: 'inspection_required', stateReason: t.bed.stateReason }, after: { status: 'passed', bed: 'available', stateReason: null, inspectedBy: c.actor.staffId, cleanedBy: t.task.cleanedByStaff },
    })
    // The Admin is told who is next in the queue. No offer is made (D-108): a person decides.
    const told = await notifyFreedBed(c.tx, t.bed.id, c.now, `cleaning:${t.task.id}:passed`)
    await notify(c.tx, {
      dedupeKey: `cleaning:${t.task.id}:passed`, kind: 'cleaning.passed', to: { role: 'Rec', siteId: t.task.siteId }, ref: { type: 'cleaning_task', id: t.task.id },
      text: `Room ${t.roomName}, bed ${t.bed.code} passed its final inspection and is Available.`,
    })
    if (t.task.cleanedByStaff) {
      await notify(c.tx, { dedupeKey: `cleaning:${t.task.id}:passed:cleaner`, kind: 'cleaning.passed', to: { staffId: t.task.cleanedByStaff }, ref: { type: 'cleaning_task', id: t.task.id }, text: `Room ${t.roomName}, bed ${t.bed.code} passed inspection. Thank you.` })
    }
    return ok({ taskId: t.task.id, bedId: t.bed.id, bedState: 'available' as const, nextInQueueNotified: told }, `Passed. Bed ${t.bed.code} is now Available.`)
  })
}

/* ---------------- fail ---------------- */

export const failInput = z.object({
  taskId: idSchema,
  /** What is wrong, in words the housekeeper can act on. */
  note: z.string().trim().min(3, 'Say what has to be redone (at least 3 characters)').max(1000, 'At most 1000 characters'),
  attachmentIds: z.array(idSchema).max(10).optional(),
})
export type FailInspectionInput = z.infer<typeof failInput>
export interface FailInspectionOut { taskId: string; newTaskId: string; bedState: 'needs_cleaning' }

export function failInspection(rc: RequestContext, i: FailInspectionInput): Promise<Result<FailInspectionOut>> {
  return runCommand(rc, async c => {
    const t = await loadForInspection(c, i.taskId)
    if (isFailure(t)) return t
    const badFiles = await checkAttachments(c.tx, t.task.id, i.attachmentIds)
    if (badFiles) return badFiles
    await c.tx.update(cleaningTask).set({ status: 'failed', inspectedByStaff: c.actor.staffId!, inspectedBy: c.user.id, inspectedAt: c.now, inspectionNote: i.note }).where(eq(cleaningTask.id, t.task.id))
    await c.tx.update(bed).set({ state: 'needs_cleaning', stateReason: `Failed inspection: ${i.note}`.slice(0, 300), stateSince: c.now }).where(eq(bed.id, t.bed.id))
    const fresh = await openCleaningTask(c.tx, { bedId: t.bed.id, reason: 'Failed inspection', now: c.now })
    if (!fresh?.created) throw new Error('a fresh cleaning task could not be opened after a failed inspection')
    await audit(c, {
      action: 'readiness.inspection.failed', entityType: 'cleaning_task', entityId: t.task.id, siteId: t.task.siteId, reason: i.note,
      before: { status: 'cleaned', bed: 'inspection_required' }, after: { status: 'failed', bed: 'needs_cleaning', newTaskId: fresh.taskId, attachments: [...new Set(i.attachmentIds ?? [])].length },
    })
    if (t.task.cleanedByStaff) {
      await notify(c.tx, {
        dedupeKey: `cleaning:${t.task.id}:failed`, kind: 'cleaning.failed', to: { staffId: t.task.cleanedByStaff }, ref: { type: 'cleaning_task', id: fresh.taskId },
        text: `Room ${t.roomName}, bed ${t.bed.code} did not pass inspection. To redo: ${i.note}. Reception will assign the new task.`,
      })
    }
    return ok({ taskId: t.task.id, newTaskId: fresh.taskId, bedState: 'needs_cleaning' as const }, `Failed. Bed ${t.bed.code} goes back to cleaning with a new task.`)
  })
}
