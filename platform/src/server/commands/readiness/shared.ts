/**
 * Helpers shared by the WP-J commands (cleaning, final inspection, bed readiness).
 *
 * Locking order, everywhere in this package: bed row first, then the cleaning task row (the way checkout and transfer reach
 * the bed before they open a task). Assignment only needs the task row.
 *
 * Separation of duties (D-26): nobody cleans or inspects the room they live in, and the inspector is never the cleaner. Those
 * checks live here so the three commands cannot drift apart; the database check `cleaning_cleaner_not_inspector` is the second line.
 */
import { and, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { bed, room, staffProfile, stay, userAccount } from '@/server/db/schema'
import { attachment, cleaningTask } from '@/server/db/schema.stage3'
import type { Tx } from '@/server/command/context'
import { fail, failure, type Failure } from '@/server/command/result'
import { OCCUPYING_STAY_STATUSES } from '@/domain/enums'
import { loadAccess } from '@/server/auth/actor'

export { idSchema, reasonSchema } from '@/server/commands/property/shared'
export const noteSchema = z.string().trim().max(1000, 'At most 1000 characters').nullish().transform(v => (v ? v : null))

/** The checklist line that means "damage or missing items noticed". With a note it is a reportable issue. OPEN: could become a flag on the registry line. */
export const DAMAGE_LINE = 'damage'

/** What is stored in `cleaning_task.checklist`: the lines as they were when the housekeeper answered them. */
export interface ChecklistRecord {
  version: 1
  lines: { id: string; label: string; required: boolean; done: boolean }[]
  notes: string | null
  issue: boolean
  attachmentIds: string[]
}

export type TaskRow = typeof cleaningTask.$inferSelect
export type BedRow = typeof bed.$inferSelect
export interface TaskCtx { task: TaskRow; bed: BedRow; roomId: string; roomName: string }

/** Locks the bed, then the task (see the ordering note above). Undefined = no such task. */
export async function loadTaskLocked(tx: Tx, taskId: string): Promise<TaskCtx | undefined> {
  const [pre] = await tx.select({ bedId: cleaningTask.bedId }).from(cleaningTask).where(eq(cleaningTask.id, taskId)).limit(1)
  if (!pre) return undefined
  const [b] = await tx.select().from(bed).where(eq(bed.id, pre.bedId)).limit(1).for('update')
  const [t] = await tx.select().from(cleaningTask).where(eq(cleaningTask.id, taskId)).limit(1).for('update')
  if (!b || !t) return undefined
  const [r] = await tx.select({ name: room.name }).from(room).where(eq(room.id, b.roomId)).limit(1)
  return { task: t, bed: b, roomId: b.roomId, roomName: r?.name ?? '' }
}

/** Does this person have a live stay (provisional, active or resolution pending) in a bed of this room? */
export async function livesInRoom(q: Pick<Tx, 'select'>, staffId: string, roomId: string): Promise<boolean> {
  const rows = await q.select({ id: stay.id }).from(stay).innerJoin(bed, eq(bed.id, stay.bedId))
    .where(and(eq(stay.staffId, staffId), inArray(stay.status, [...OCCUPYING_STAY_STATUSES]), eq(bed.roomId, roomId))).limit(1)
  return rows.length > 0
}

export type Housekeeper = { ok: true; userId: string; name: string } | { ok: false; why: string }

/**
 * Can this person be given a cleaning task? They must be an employee still employed, with a login that can be used, who holds an
 * ACTIVE Housekeeping capability grant (started, not expired, not revoked: the same evaluation sign-in uses, `loadAccess`).
 */
export async function checkHousekeeper(tx: Pick<Tx, 'select'>, staffId: string, now: Date): Promise<Housekeeper> {
  const [p] = await tx.select({ name: staffProfile.fullName, status: staffProfile.employmentStatus, archivedAt: staffProfile.archivedAt }).from(staffProfile).where(eq(staffProfile.id, staffId)).limit(1)
  if (!p) return { ok: false, why: 'That person does not exist' }
  if (p.status !== 'active' || p.archivedAt) return { ok: false, why: `${p.name} is no longer an active employee` }
  const [u] = await tx.select({ id: userAccount.id, status: userAccount.status, revokedAt: userAccount.revokedAt }).from(userAccount).where(eq(userAccount.staffId, staffId)).limit(1)
  if (!u || u.revokedAt || (u.status !== 'active' && u.status !== 'locked')) return { ok: false, why: `${p.name} has no working login, so they could not see the task` }
  const access = await loadAccess(tx, u.id, now)
  if (!access.caps.includes('Housekeeping')) return { ok: false, why: `${p.name} does not hold the Housekeeping capability` }
  return { ok: true, userId: u.id, name: p.name }
}

/** Evidence photos must already be attached to THIS task (upload them first through /api/v1/attachments). */
export async function checkAttachments(tx: Pick<Tx, 'select'>, taskId: string, ids: readonly string[] | undefined): Promise<Failure | undefined> {
  if (!ids || ids.length === 0) return undefined
  const unique = [...new Set(ids)]
  const rows = await tx.select({ id: attachment.id }).from(attachment).where(and(eq(attachment.entityType, 'cleaning_task'), eq(attachment.entityId, taskId), inArray(attachment.id, unique)))
  if (rows.length !== unique.length) return fail.invalid('A photo or file is not attached to this task', { attachmentIds: 'Upload the files to this task first' })
  return undefined
}

export const stateWords = (s: string) => s.replace(/_/g, ' ')

/** The task is not in the stage this step needs. */
export function wrongStage(t: TaskRow, wanted: 'open' | 'cleaned'): Failure {
  const says: Record<string, string> = {
    open: 'is still waiting to be cleaned', cleaned: 'is cleaned and waiting for the final inspection', passed: 'has already passed its final inspection',
    failed: 'failed its inspection and was replaced by a new cleaning task', cancelled: 'was cancelled',
  }
  const owner = t.status === 'open' ? 'Housekeeper' : t.status === 'cleaned' ? 'Final Inspection holder' : 'Reception'
  const next = t.status === 'open' ? 'Clean the room and tick the checklist' : t.status === 'cleaned' ? 'Inspect the room and pass or fail it' : 'Open the current task for this bed on the Housekeeping page'
  return failure('conflict', `This cleaning task ${says[t.status] ?? t.status}`, { owner, next, detail: { reason: wanted === 'open' ? 'not_open' : 'not_cleaned', status: t.status } })
}

/** The bed is not in the physical state this step needs (for example it was blocked after the task was opened). */
export function wrongBedState(b: BedRow, needs: 'needs_cleaning' | 'inspection_required'): Failure {
  const what = b.state === 'blocked' ? 'blocked' : b.state === 'under_maintenance' ? 'under maintenance' : stateWords(b.state)
  const owner = b.state === 'blocked' || b.state === 'under_maintenance' ? 'Maintenance Coordinator' : 'Reception'
  const next = b.state === 'blocked' ? 'Unblock the bed; it then goes back to cleaning and inspection' : b.state === 'under_maintenance' ? 'Finish the maintenance work; the bed then returns to cleaning' : 'Open the board and check the bed and its task; cancel a stale task if the bed has moved on'
  return failure('conflict', `Bed ${b.code} is ${what}, not ${stateWords(needs)}`, { owner, next, detail: { reason: 'bed_state', state: b.state, needs } })
}

/** D-26 wording. */
export const ownRoom = (roomName: string, verb: 'clean' | 'inspect' | 'be given') =>
  fail.sod(verb === 'be given' ? `This person lives in room ${roomName}, so they cannot be given its cleaning` : `You live in room ${roomName}: you cannot ${verb} your own room`,
    verb === 'clean' ? 'Another housekeeper cleans this room (Reception assigns)' : verb === 'inspect' ? 'Another Final Inspection holder inspects this room' : 'Choose another housekeeper')
