/** Pieces shared by the transfer and swap commands (request, consent, approve, reject, execute, cancel). */
import { and, eq, inArray, or } from 'drizzle-orm'
import { z } from 'zod'
import { bed } from '@/server/db/schema'
import { transferRequest } from '@/server/db/schema.stays'
import type { CommandContext, Tx } from '@/server/command/context'
import { fail, type Failure, type Result } from '@/server/command/result'
import { mapDbError } from '@/server/command/run'
import { staffName } from './shared'

export type TransferRow = typeof transferRequest.$inferSelect

export async function loadTransfer(tx: Tx, id: string, lock: boolean): Promise<TransferRow | undefined> {
  const q = tx.select().from(transferRequest).where(eq(transferRequest.id, id))
  return lock ? (await q.for('update'))[0] : (await q)[0]
}

/** Open transfers or swaps that already involve one of these stays (a stay is in at most one at a time). */
export async function openTransfersFor(tx: Tx, stayIds: string[]): Promise<TransferRow[]> {
  return tx.select().from(transferRequest).where(and(
    inArray(transferRequest.status, ['requested', 'approved']),
    or(inArray(transferRequest.stayId, stayIds), inArray(transferRequest.otherStayId, stayIds)),
  ))
}

export const consentVia = z.enum(['in_person', 'phone', 'written'])
export const consentInput = z.object({ via: consentVia, note: z.string().trim().max(300).nullish().transform(v => v ?? null) })

/** The destination of a transfer must be a live bed of the SAME site as the stay, and not the bed the person is already in. */
export async function checkDestination(tx: Tx, o: { siteId: string; currentBedId: string }, bedId: string): Promise<Failure | undefined> {
  const [b] = await tx.select({ id: bed.id, siteId: bed.siteId, archivedAt: bed.archivedAt, state: bed.state }).from(bed).where(eq(bed.id, bedId)).limit(1)
  if (!b) return fail.invalid('That bed does not exist', { destinationBedId: 'Choose a bed from the list' })
  if (b.siteId !== o.siteId) {
    return fail.conflict('A move to another site is a new accommodation request, not a transfer', 'Accommodation Admin', 'Ask the resident to request the other site, or choose a bed in this site', { reason: 'cross_site' })
  }
  if (b.id === o.currentBedId) return fail.invalid('The destination is the bed the resident is already in', { destinationBedId: 'Choose a different bed' })
  if (b.archivedAt || b.state === 'archived') return fail.invalid('That bed is archived', { destinationBedId: 'Choose a different bed' })
  return undefined
}

/** Marks a failure as "the move was attempted and could not be completed": the wrapper records it after the rollback. */
export function executionFailed(f: Failure, prefix?: string): Failure {
  const detail = { ...(typeof f.detail === 'object' && f.detail !== null ? f.detail as object : {}), executionFailed: true }
  return { ...f, reason: prefix ? `${prefix}: ${f.reason}` : f.reason, detail }
}
export const isExecutionFailure = (f: Failure) => (f.detail as { executionFailed?: boolean } | undefined)?.executionFailed === true

/**
 * Runs `fn` inside a savepoint. A database refusal (the exclusion constraint, a transition guard) becomes a normal failure
 * and the surrounding transaction stays usable; the caller then returns it, which rolls the whole command back.
 */
export async function guarded<T>(c: CommandContext, fn: (c2: CommandContext) => Promise<Result<T>>): Promise<Result<T>> {
  try {
    return await c.tx.transaction(async sp => {
      const r = await fn({ ...c, tx: sp as unknown as Tx })
      if (!r.ok) throw new Soft(r)
      return r
    })
  } catch (e) {
    if (e instanceof Soft) return e.failure as Failure
    const mapped = mapDbError(e)
    if (mapped) return mapped
    throw e
  }
}
class Soft extends Error { constructor(readonly failure: Failure) { super(failure.reason) } }

export async function involvedNames(tx: Tx, t: Pick<TransferRow, 'staffId' | 'otherStaffId'>): Promise<string> {
  const a = await staffName(tx, t.staffId)
  return t.otherStaffId ? `${a} and ${await staffName(tx, t.otherStaffId)}` : a
}

export const OPEN_TRANSFER: TransferRow['status'][] = ['requested', 'approved', 'failed']
