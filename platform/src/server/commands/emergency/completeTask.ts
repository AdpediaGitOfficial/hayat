import { and, eq, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { stay } from '@/server/db/schema'
import { emergencyCheckin, task } from '@/server/db/schema.emergency'
import { audit } from '@/server/audit'
import { authorize, notSelf } from '@/server/command/authorize'
import { runCommand } from '@/server/command/run'
import type { RequestContext } from '@/server/command/context'
import { fail, failure, ok, type Result } from '@/server/command/result'
import { idSchema, parseInput, textSchema } from './shared'

export const completeTaskInput = z.object({
  taskId: idSchema,
  /** What was done: where the resident went, or that they were checked out. */
  note: textSchema('Say what was done (relocated to which bed, or checked out)'),
})
export type CompleteTaskInput = z.input<typeof completeTaskInput>

export interface CompleteTaskOut { taskId: string; doneAt: string }

/**
 * Marks a relocation or checkout task done (D-69). The work itself is a transfer or a checkout on the stay (WP-F); this
 * records that a person did it. It refuses while the resident is still in the rejected provisional stay, so a task cannot
 * be ticked off without the resident having been dealt with by a human.
 */
export async function completeTask(rc: RequestContext, raw: CompleteTaskInput): Promise<Result<CompleteTaskOut>> {
  const p = parseInput(completeTaskInput, raw)
  if (!p.ok) return p
  const i = p.data
  return runCommand(rc, async c => {
    const [t] = await c.tx.select().from(task).where(and(eq(task.id, i.taskId), isNull(task.archivedAt))).limit(1).for('update')
    if (!t) return fail.notFound()
    const denied = authorize(c, 'emergency_checkin.approve', { siteId: t.siteId })
    if (denied) return denied
    if (t.doneAt) return failure('conflict', 'This task is already done', { owner: 'Accommodation Admin', next: 'Nothing more to do', detail: { reason: 'already_done' } })

    if (t.refType === 'emergency_checkin' && t.refId) {
      const [k] = await c.tx.select({ staffId: emergencyCheckin.staffId, stayId: emergencyCheckin.stayId, stayStatus: stay.status }).from(emergencyCheckin)
        .innerJoin(stay, eq(stay.id, emergencyCheckin.stayId)).where(eq(emergencyCheckin.id, t.refId)).limit(1)
      if (k) {
        const self = notSelf(c, k.staffId, 'close the relocation task')
        if (self) return self
        if (k.stayStatus === 'resolution_pending') {
          return failure('conflict', 'The resident is still in the bed from the rejected emergency check-in', {
            owner: 'Accommodation Admin', next: 'Transfer them to a bed or check them out on the stay, then mark this task done', detail: { reason: 'resident_still_in_bed', stayId: k.stayId },
          })
        }
      }
    }

    await c.tx.update(task).set({ doneAt: c.now, doneBy: c.user.id, doneNote: i.note }).where(eq(task.id, t.id))
    await audit(c, {
      action: 'emergency.task_completed', entityType: 'task', entityId: t.id, siteId: t.siteId, reason: i.note,
      before: { done: false, dueAt: t.dueAt?.toISOString() ?? null }, after: { done: true, doneAt: c.now.toISOString(), refType: t.refType, refId: t.refId },
    })
    return ok({ taskId: t.id, doneAt: c.now.toISOString() }, 'Task marked done.')
  })
}
