/**
 * A cleaning task opened BY HAND for a bed that has none (S-22, P-14; PROPOSED, pending client sign-off, action `housekeeping_readiness.assign`:
 * Reception and Super Admin, at the bed's site, a reason is mandatory and the action is audited).
 *
 * Why it exists: a bed can be in Needs cleaning or Inspection required with no task behind it (migrated or seeded data, a task cancelled by
 * mistake). The board then shows "no task on record" and nobody can move it on, because only a task leads to a final inspection. Stage 4
 * work-order completion opens a task by itself (markBedNeedsWork); this is the hand path for what is already there.
 *
 *  - Needs cleaning: a normal open task, assigned afterwards like any other.
 *  - Inspection required: the task is created already CLEANED, with the note that readiness was restored without a cleaning record and NO
 *    cleaner (`cleaned_by_staff` stays null). The final inspection can proceed. The inspector rules are unchanged: the database check needs the
 *    cleaner and the inspector to differ only when both exist. One thing is added for this path only: whoever opened the task by hand is
 *    never the one who inspects it (D-26), because nobody else has vouched for the room yet.
 *
 * The bed is never made Available here: only a passed final inspection does (D-64).
 */
import { and, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { bed } from '@/server/db/schema'
import { cleaningTask } from '@/server/db/schema.stage3'
import { audit } from '@/server/audit'
import { authorize } from '@/server/command/authorize'
import { runCommand } from '@/server/command/run'
import type { RequestContext } from '@/server/command/context'
import { fail, failure, ok, type Result } from '@/server/command/result'
import { notify } from '@/server/notify'
import { openCleaningTask } from '@/server/readiness/hooks'
import type { ChecklistRecord } from './shared'
import { idSchema, reasonSchema, stateWords } from './shared'

export const NO_RECORD_NOTE = 'Readiness restored without a cleaning record (migrated or seeded data)'

export const manualInput = z.object({ bedId: idSchema, reason: reasonSchema })
export type OpenCleaningTaskManualInput = z.infer<typeof manualInput>
export interface OpenCleaningTaskManualOut { taskId: string; bedId: string; bedState: 'needs_cleaning' | 'inspection_required'; taskStatus: 'open' | 'cleaned' }

const NOT_FOR: Record<string, { why: (code: string) => string; owner: string; next: string }> = {
  available: { why: c => `Bed ${c} is Available: it is ready, so it does not need a cleaning task`, owner: 'Reception', next: 'Nothing to do. If the room really needs cleaning, ask the Maintenance Coordinator to block it' },
  occupied: { why: c => `Bed ${c} is occupied`, owner: 'Reception', next: 'A task opens by itself when the resident checks out' },
  blocked: { why: c => `Bed ${c} is blocked`, owner: 'Maintenance Coordinator', next: 'Unblock the bed; it then goes to cleaning with a task of its own' },
  under_maintenance: { why: c => `Bed ${c} is under maintenance`, owner: 'Maintenance Coordinator', next: 'Finish the work; the bed then goes to cleaning with a task of its own' },
  archived: { why: c => `Bed ${c} is archived`, owner: 'Super Admin', next: 'An archived bed is out of use' },
}

export function openCleaningTaskManual(rc: RequestContext, i: OpenCleaningTaskManualInput): Promise<Result<OpenCleaningTaskManualOut>> {
  return runCommand(rc, async c => {
    // Bed first (the order of every readiness command), then its task.
    const [b] = await c.tx.select().from(bed).where(eq(bed.id, i.bedId)).limit(1).for('update')
    if (!b) return fail.notFound()
    const denied = authorize(c, 'housekeeping_readiness.assign', { siteId: b.siteId })
    if (denied) return denied

    const refuse = b.archivedAt ? NOT_FOR.archived : NOT_FOR[b.state]
    if (refuse) return failure('conflict', refuse.why(b.code), { owner: refuse.owner, next: refuse.next, detail: { reason: 'bed_state', state: b.archivedAt ? 'archived' : b.state } })
    const [live] = await c.tx.select({ id: cleaningTask.id, status: cleaningTask.status }).from(cleaningTask)
      .where(and(eq(cleaningTask.bedId, b.id), inArray(cleaningTask.status, ['open', 'cleaned']))).limit(1)
    if (live) {
      return failure('conflict', `Bed ${b.code} already has a ${live.status === 'open' ? 'cleaning' : 'cleaned'} task`, {
        owner: 'Reception', next: live.status === 'open' ? 'Assign it to a housekeeper from the board' : 'A Final Inspection holder inspects it', detail: { reason: 'task_exists', taskId: live.id, status: live.status },
      })
    }

    const reason = `Opened by hand: ${i.reason}`
    let taskId: string
    let taskStatus: 'open' | 'cleaned'
    if (b.state === 'needs_cleaning') {
      const t = await openCleaningTask(c.tx, { bedId: b.id, reason, now: c.now })
      if (!t?.created) return failure('conflict', `Bed ${b.code} already has a cleaning task`, { owner: 'Reception', next: 'Open the board and assign it', detail: { reason: 'task_exists' } })
      taskId = t.taskId
      taskStatus = 'open'
    } else if (b.state === 'inspection_required') {
      const record: ChecklistRecord = { version: 1, lines: [], notes: NO_RECORD_NOTE, issue: false, attachmentIds: [] }
      const rows = await c.tx.insert(cleaningTask).values({
        bedId: b.id, siteId: b.siteId, reason, status: 'cleaned', cleanedAt: c.now, checklist: record, assignedBy: c.user.id, createdAt: c.now,
      }).onConflictDoNothing().returning({ id: cleaningTask.id })
      if (rows.length === 0) return failure('conflict', `Bed ${b.code} already has a task`, { owner: 'Reception', next: 'Open the board', detail: { reason: 'task_exists' } })
      taskId = rows[0].id
      taskStatus = 'cleaned'
      await notify(c.tx, {
        dedupeKey: `cleaning:${taskId}:cleaned`, kind: 'cleaning.cleaned', to: { role: 'FinalInspection', siteId: b.siteId }, ref: { type: 'cleaning_task', id: taskId },
        text: `Bed ${b.code} is waiting for the final inspection. It has no cleaning record, so a task was opened by hand (${i.reason}). Inspect the room, then pass or fail it.`,
      })
    } else {
      return failure('conflict', `Bed ${b.code} is ${stateWords(b.state)}`, { owner: 'Reception', next: 'Open the board' })
    }
    await audit(c, {
      action: 'readiness.cleaning.opened_manually', entityType: 'cleaning_task', entityId: taskId, siteId: b.siteId, reason: i.reason,
      before: { bed: b.state, task: null }, after: { bed: b.state, bedId: b.id, bedCode: b.code, task: taskStatus, cleanedBy: null, note: taskStatus === 'cleaned' ? NO_RECORD_NOTE : null, proposal: 'P-14, pending client sign-off' },
    })
    return ok({ taskId, bedId: b.id, bedState: b.state as 'needs_cleaning' | 'inspection_required', taskStatus },
      taskStatus === 'open' ? `A cleaning task is open for bed ${b.code}. Assign a housekeeper.` : `Bed ${b.code} is ready for the final inspection (no cleaning record; noted).`)
  })
}
