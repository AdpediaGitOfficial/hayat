/**
 * The housekeeper records a cleaning (D-23, SRS 12.53). ONE transaction: the checklist is stored as it was answered, the task
 * becomes `cleaned`, the bed goes Needs cleaning -> Inspection required. Cleaning alone NEVER makes a bed Available (D-64): only a
 * passed final inspection does (inspect.ts).
 *
 * Only the assigned housekeeper may do this (job scope: anyone else reads as "not found"), never for a room they live in (D-26).
 * "Damage or missing items noticed" ticked needs a note; it is a reportable issue: audited and the Maintenance Coordinator of the site is told
 * (work orders are Stage 4).
 */
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { bed } from '@/server/db/schema'
import { cleaningTask } from '@/server/db/schema.stage3'
import { audit } from '@/server/audit'
import { authorize } from '@/server/command/authorize'
import { runCommand } from '@/server/command/run'
import type { RequestContext } from '@/server/command/context'
import { fail, failure, ok, type Result } from '@/server/command/result'
import { getConfig } from '@/server/config/registry'
import { notify } from '@/server/notify'
import { checkAttachments, DAMAGE_LINE, idSchema, livesInRoom, loadTaskLocked, noteSchema, ownRoom, wrongBedState, wrongStage, type ChecklistRecord } from './shared'

export const cleanInput = z.object({
  taskId: idSchema,
  /** Checklist line id -> ticked. Every required line of `readiness.cleaning_checklist` must be true. */
  checklist: z.record(z.string().max(40), z.boolean()),
  notes: noteSchema,
  attachmentIds: z.array(idSchema).max(10).optional(),
})
export type CompleteCleaningInput = z.infer<typeof cleanInput>
export interface CompleteCleaningOut { taskId: string; bedId: string; bedState: 'inspection_required'; issueReported: boolean }

export function completeCleaning(rc: RequestContext, i: CompleteCleaningInput): Promise<Result<CompleteCleaningOut>> {
  return runCommand(rc, async c => {
    const t = await loadTaskLocked(c.tx, i.taskId)
    if (!t) return fail.notFound()
    const denied = authorize(c, 'housekeeping_readiness.clean', { siteId: t.task.siteId, assigneeStaffId: t.task.assignedToStaff ?? undefined })
    if (denied) return denied
    const me = c.actor.staffId
    if (!me) return fail.forbidden('do this without a staff record')
    if (await livesInRoom(c.tx, me, t.roomId)) return ownRoom(t.roomName, 'clean')
    if (t.task.status !== 'open') return wrongStage(t.task, 'open')
    if (t.bed.state !== 'needs_cleaning') return wrongBedState(t.bed, 'needs_cleaning')

    const lines = await getConfig(c.tx, 'readiness.cleaning_checklist')
    const known = new Set(lines.map(l => l.id))
    const unknown = Object.keys(i.checklist).filter(k => !known.has(k))
    if (unknown.length > 0) return fail.invalid('The checklist has a line that does not exist', Object.fromEntries(unknown.map(k => [`checklist.${k}`, 'Unknown line'])))
    const missing = lines.filter(l => l.required && i.checklist[l.id] !== true)
    if (missing.length > 0) {
      return failure('invalid', `Tick every required line first. Still to do: ${missing.map(m => m.label).join(', ')}`, {
        fields: Object.fromEntries(missing.map(m => [`checklist.${m.id}`, 'Required'])), owner: 'Housekeeper', next: 'Finish the room, tick the lines, then submit',
        detail: { reason: 'checklist_incomplete', missing: missing.map(m => ({ id: m.id, label: m.label })) },
      })
    }
    const issue = i.checklist[DAMAGE_LINE] === true
    if (issue && !i.notes) return fail.invalid('Describe the damage or what is missing', { notes: 'A note is needed when damage or missing items are noticed' })
    const badFiles = await checkAttachments(c.tx, t.task.id, i.attachmentIds)
    if (badFiles) return badFiles

    const record: ChecklistRecord = {
      version: 1, notes: i.notes, issue, attachmentIds: [...new Set(i.attachmentIds ?? [])],
      lines: lines.map(l => ({ id: l.id, label: l.label, required: l.required, done: i.checklist[l.id] === true })),
    }
    await c.tx.update(cleaningTask).set({ status: 'cleaned', cleanedByStaff: me, cleanedAt: c.now, checklist: record }).where(eq(cleaningTask.id, t.task.id))
    await c.tx.update(bed).set({ state: 'inspection_required', stateReason: 'Cleaned, awaiting final inspection', stateSince: c.now }).where(eq(bed.id, t.bed.id))

    await audit(c, {
      action: 'readiness.cleaning.completed', entityType: 'cleaning_task', entityId: t.task.id, siteId: t.task.siteId, reason: i.notes ?? undefined,
      before: { status: 'open', bed: 'needs_cleaning' },
      after: { status: 'cleaned', bed: 'inspection_required', cleanedBy: me, ticked: record.lines.filter(l => l.done).length, of: record.lines.length, issue, attachments: record.attachmentIds.length },
    })
    if (issue) {
      await audit(c, {
        action: 'readiness.cleaning.issue_reported', entityType: 'cleaning_task', entityId: t.task.id, siteId: t.task.siteId, reason: i.notes ?? undefined,
        after: { bed: t.bed.code, room: t.roomName, attachments: record.attachmentIds.length },
      })
      await notify(c.tx, {
        dedupeKey: `cleaning:${t.task.id}:issue`, kind: 'cleaning.issue', to: { role: 'MC', siteId: t.task.siteId }, ref: { type: 'cleaning_task', id: t.task.id },
        text: `Damage or missing items reported while cleaning room ${t.roomName}, bed ${t.bed.code}: ${i.notes}`,
      })
    }
    await notify(c.tx, {
      dedupeKey: `cleaning:${t.task.id}:cleaned`, kind: 'cleaning.cleaned', to: { role: 'FinalInspection', siteId: t.task.siteId }, ref: { type: 'cleaning_task', id: t.task.id },
      text: `Room ${t.roomName}, bed ${t.bed.code} is cleaned and waiting for the final inspection.${issue ? ' Damage or missing items were reported.' : ''}`,
    })
    return ok({ taskId: t.task.id, bedId: t.bed.id, bedState: 'inspection_required' as const, issueReported: issue },
      'Cleaning recorded. The bed is not available yet: it needs the final inspection.')
  })
}
