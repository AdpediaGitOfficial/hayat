/**
 * Assigning a cleaning task to a housekeeper, and cancelling a task that no longer applies (GH-18: Reception assigns).
 *
 * The assignee must hold an ACTIVE Housekeeping capability grant and must not live in the room (D-26). A task can be reassigned
 * while it is open, with a reason. Nothing here touches the bed: a bed only becomes Available through a passed final inspection.
 */
import { and, count, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { auditEvent, staffProfile } from '@/server/db/schema'
import { cleaningTask } from '@/server/db/schema.stage3'
import { audit } from '@/server/audit'
import { authorize } from '@/server/command/authorize'
import { runCommand } from '@/server/command/run'
import type { RequestContext } from '@/server/command/context'
import { fail, failure, ok, type Result } from '@/server/command/result'
import { notify } from '@/server/notify'
import { openCleaningTask } from '@/server/readiness/hooks'
import { checkHousekeeper, idSchema, livesInRoom, loadTaskLocked, noteSchema, ownRoom, reasonSchema, wrongBedState, wrongStage } from './shared'

const nameOf = async (q: Parameters<typeof checkHousekeeper>[0], staffId: string) =>
  (await q.select({ n: staffProfile.fullName }).from(staffProfile).where(eq(staffProfile.id, staffId)).limit(1))[0]?.n ?? 'The housekeeper'

/* ---------------- assign ---------------- */

export const assignInput = z.object({ taskId: idSchema, housekeeperStaffId: idSchema, note: noteSchema })
export type AssignCleaningInput = z.infer<typeof assignInput>
export interface AssignCleaningOut { taskId: string; assignedTo: string; reassigned: boolean }

export function assignCleaning(rc: RequestContext, i: AssignCleaningInput): Promise<Result<AssignCleaningOut>> {
  return runCommand(rc, async c => {
    const t = await loadTaskLocked(c.tx, i.taskId)
    if (!t) return fail.notFound()
    const denied = authorize(c, 'housekeeping_readiness.assign', { siteId: t.task.siteId })
    if (denied) return denied
    if (t.task.status !== 'open') return wrongStage(t.task, 'open')
    if (t.bed.state !== 'needs_cleaning') return wrongBedState(t.bed, 'needs_cleaning')

    const prev = t.task.assignedToStaff
    if (prev === i.housekeeperStaffId) return ok({ taskId: t.task.id, assignedTo: prev, reassigned: false }, 'Already assigned to them.')

    const hk = await checkHousekeeper(c.tx, i.housekeeperStaffId, c.now)
    if (!hk.ok) {
      return failure('invalid', hk.why, { fields: { housekeeperStaffId: hk.why }, owner: 'Super Admin (grants capabilities with a second Super Admin)', next: 'Choose someone who holds the Housekeeping capability, or ask for the grant' })
    }
    if (await livesInRoom(c.tx, i.housekeeperStaffId, t.roomId)) return ownRoom(t.roomName, 'be given')
    if (prev) {
      const was = await nameOf(c.tx, prev)
      if (!i.note || i.note.length < 3) {
        return failure('conflict', `This task is already assigned to ${was}. To change it, give a reason`, { owner: 'Reception', next: 'Add a reason and assign again, or leave it with them', fields: { note: 'A reason is needed to reassign' }, detail: { reason: 'already_assigned', assignedTo: prev } })
      }
    }

    // The n-th assignment of this task: keeps every notification event-based (a task handed A, then B, then A again tells A twice).
    const [{ n }] = await c.tx.select({ n: count() }).from(auditEvent).where(and(eq(auditEvent.entityId, t.task.id), inArray(auditEvent.action, ['readiness.cleaning.assigned', 'readiness.cleaning.reassigned'])))
    await c.tx.update(cleaningTask).set({ assignedToStaff: i.housekeeperStaffId, assignedBy: c.user.id, assignedAt: c.now }).where(eq(cleaningTask.id, t.task.id))
    await audit(c, {
      action: prev ? 'readiness.cleaning.reassigned' : 'readiness.cleaning.assigned', entityType: 'cleaning_task', entityId: t.task.id, siteId: t.task.siteId, reason: i.note ?? undefined,
      before: { assignedTo: prev }, after: { assignedTo: i.housekeeperStaffId, bed: t.bed.code, room: t.roomName },
    })
    await notify(c.tx, {
      dedupeKey: `cleaning:${t.task.id}:assigned:${n + 1}`, kind: 'cleaning.assigned', to: { staffId: i.housekeeperStaffId }, ref: { type: 'cleaning_task', id: t.task.id },
      text: `Cleaning assigned to you: room ${t.roomName}, bed ${t.bed.code} (${t.task.reason}). Open Housekeeping to see your rooms.`,
    })
    if (prev) {
      await notify(c.tx, {
        dedupeKey: `cleaning:${t.task.id}:unassigned:${n + 1}`, kind: 'cleaning.unassigned', to: { staffId: prev }, ref: { type: 'cleaning_task', id: t.task.id },
        text: `Room ${t.roomName}, bed ${t.bed.code} was taken off your list${i.note ? `: ${i.note}` : ''}.`,
      })
    }
    return ok({ taskId: t.task.id, assignedTo: i.housekeeperStaffId, reassigned: !!prev }, `Assigned to ${hk.name}.`)
  })
}

/* ---------------- cancel ---------------- */

export const cancelInput = z.object({ taskId: idSchema, reason: reasonSchema })
export type CancelTaskInput = z.infer<typeof cancelInput>
export interface CancelTaskOut { taskId: string; reopenedTaskId: string | null }

/**
 * Cancels a task that no longer matches its bed: the bed was blocked or is leaving use, or the bed moved on while a task sat
 * there (a cleaned task whose bed went through a block). A task whose bed STILL needs that very step cannot be cancelled,
 * because that would leave the bed stuck with nobody responsible: block the bed first if it is out of use.
 * If the bed is back in Needs cleaning, a fresh task is opened so it is never left without one.
 */
export function cancelTask(rc: RequestContext, i: CancelTaskInput): Promise<Result<CancelTaskOut>> {
  return runCommand(rc, async c => {
    const t = await loadTaskLocked(c.tx, i.taskId)
    if (!t) return fail.notFound()
    const denied = authorize(c, 'housekeeping_readiness.assign', { siteId: t.task.siteId })
    if (denied) return denied
    if (t.task.status === 'cancelled') return ok({ taskId: t.task.id, reopenedTaskId: null }, 'Already cancelled.')
    if (t.task.status !== 'open' && t.task.status !== 'cleaned') return wrongStage(t.task, 'open')
    const consistent = (t.task.status === 'open' && t.bed.state === 'needs_cleaning') || (t.task.status === 'cleaned' && t.bed.state === 'inspection_required')
    if (consistent) {
      return failure('conflict', `Bed ${t.bed.code} still needs ${t.task.status === 'open' ? 'cleaning' : 'its final inspection'}, so this task cannot be cancelled`, {
        owner: 'Maintenance Coordinator or Super Admin', next: 'If the bed is going out of use, block it first; then cancel the task', detail: { reason: 'task_still_needed', status: t.task.status, bedState: t.bed.state },
      })
    }
    await c.tx.update(cleaningTask).set({ status: 'cancelled' }).where(eq(cleaningTask.id, t.task.id))
    let reopened: string | null = null
    if (t.bed.state === 'needs_cleaning') {
      const r = await openCleaningTask(c.tx, { bedId: t.bed.id, reason: 'Reopened: the earlier task was cancelled', now: c.now })
      reopened = r?.created ? r.taskId : null
    }
    await audit(c, {
      action: 'readiness.cleaning.cancelled', entityType: 'cleaning_task', entityId: t.task.id, siteId: t.task.siteId, reason: i.reason,
      before: { status: t.task.status, bed: t.bed.state }, after: { status: 'cancelled', reopenedTaskId: reopened },
    })
    if (t.task.assignedToStaff) {
      await notify(c.tx, {
        dedupeKey: `cleaning:${t.task.id}:cancelled`, kind: 'cleaning.cancelled', to: { staffId: t.task.assignedToStaff }, ref: { type: 'cleaning_task', id: t.task.id },
        text: `The cleaning of room ${t.roomName}, bed ${t.bed.code} was cancelled: ${i.reason}.`,
      })
    }
    return ok({ taskId: t.task.id, reopenedTaskId: reopened }, 'Task cancelled.')
  })
}
