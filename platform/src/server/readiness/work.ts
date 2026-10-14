/**
 * What happens to a bed when the WORK on it is finished (S-22; Stage 4 work orders call this when a work order is completed).
 *
 * A bed under maintenance returns to Needs cleaning (the legal transition "work finished"), and a cleaning task is opened through the one
 * hook every path uses (`openCleaningTask`). It does NOT make the bed Available: only a passed final inspection does (D-64). Calling it
 * twice changes nothing the second time, so a retried work-order completion is harmless. Runs inside the caller's transaction.
 */
import { and, eq, inArray } from 'drizzle-orm'
import { bed } from '@/server/db/schema'
import { cleaningTask } from '@/server/db/schema.stage3'
import type { Tx } from '@/server/command/context'
import { openCleaningTask } from './hooks'

export type NeedsWorkOutcome =
  /** The bed was under maintenance and now needs cleaning; a task was opened. */
  | { outcome: 'moved'; state: 'needs_cleaning'; taskId: string }
  /** The bed already needed cleaning (a retry, or another path got there first); its task (opened now only if it was missing). */
  | { outcome: 'already'; state: 'needs_cleaning'; taskId: string | null }
  /** The bed is in a state this must not touch (available, occupied, waiting for inspection, blocked, archived); nothing was changed. */
  | { outcome: 'left_alone'; state: string; why: string }
  | { outcome: 'not_found' }

export async function markBedNeedsWork(tx: Tx, bedId: string, reason: string, now: Date): Promise<NeedsWorkOutcome> {
  // Lock the bed first, like every path that touches a bed and then its cleaning task.
  const [b] = await tx.select().from(bed).where(eq(bed.id, bedId)).limit(1).for('update')
  if (!b) return { outcome: 'not_found' }
  if (b.archivedAt || b.state === 'archived') return { outcome: 'left_alone', state: 'archived', why: 'The bed is archived' }
  if (b.state === 'under_maintenance') {
    await tx.update(bed).set({ state: 'needs_cleaning', stateReason: `Work finished: ${reason}`.slice(0, 300), stateSince: now }).where(eq(bed.id, bedId))
    await openCleaningTask(tx, { bedId, reason: `Work finished: ${reason}`, now })
    return { outcome: 'moved', state: 'needs_cleaning', taskId: await liveTaskOf(tx, bedId) ?? '' }
  }
  if (b.state === 'needs_cleaning') {
    // Idempotent: make sure it has its task (openCleaningTask does nothing when one is open).
    await openCleaningTask(tx, { bedId, reason: `Work finished: ${reason}`, now })
    return { outcome: 'already', state: 'needs_cleaning', taskId: await liveTaskOf(tx, bedId) }
  }
  const why: Record<string, string> = {
    available: 'The bed is already Available', occupied: 'The bed is occupied', inspection_required: 'The bed is already waiting for its final inspection',
    blocked: 'The bed is blocked: unblocking it sends it to cleaning',
  }
  return { outcome: 'left_alone', state: b.state, why: why[b.state] ?? `The bed is ${b.state}` }
}

/** The bed's open cleaning task, if it has one (the database allows one per bed). */
async function liveTaskOf(tx: Tx, bedId: string): Promise<string | null> {
  const [t] = await tx.select({ id: cleaningTask.id }).from(cleaningTask).where(and(eq(cleaningTask.bedId, bedId), inArray(cleaningTask.status, ['open', 'cleaned']))).limit(1)
  return t?.id ?? null
}
