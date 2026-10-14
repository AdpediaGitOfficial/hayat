/**
 * Bulk allocation (D-60, AT-008 shape, retry-safe).
 *
 *   previewBulkAllocation  selects requests (open ones at the site, or given request ids / employee IDs), auto-matches each
 *                          to an eligible free bed with suggestBeds (each bed used once in the batch) and STORES the
 *                          result as a batch. It reserves nothing: no claim, no reservation, no request changes.
 *   confirmBulkAllocation  works the stored rows one by one. Each row is its own transaction through approveIn(), the same
 *                          path a single approval takes, so eligibility, separation of duties and the bed lock all apply.
 *                          A failed row leaves no trace except its message; confirming again skips rows already done
 *                          and retries only the ones that failed.
 */
import { and, asc, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import { accommodationRequest, bed, bedClaim, room, site, staffProfile } from '@/server/db/schema'
import { bulkAllocationBatch, bulkAllocationRow, type BulkRowOutcome } from '@/server/db/schema.requests'
import { audit } from '@/server/audit'
import { suggestBeds } from '@/server/allocation'
import { authorize } from '@/server/command/authorize'
import { runCommand } from '@/server/command/run'
import type { CommandContext, RequestContext, Tx } from '@/server/command/context'
import { fail, failure, ok, type Failure, type Result } from '@/server/command/result'
import { checkEligibility } from '@/server/eligibility'
import { claimPeriod } from '@/domain/claims'
import { approveIn } from '@/server/commands/requests/approve'
import { idSchema, wrongState, type RequestRow } from '@/server/commands/requests/shared'
import { getBulkBatch, type BulkBatchView } from '@/server/queries/requests/bulk'

const MAX_ROWS = 200

export const previewInput = z.object({
  siteId: idSchema,
  /** Specific requests. */
  requestIds: z.array(idSchema).max(MAX_ROWS).optional(),
  /** People by employee ID: each one's open request at this site is used. */
  employeeIds: z.array(z.string().trim().min(1).max(40)).max(MAX_ROWS).optional(),
})
export type PreviewBulkInput = z.infer<typeof previewInput>

export interface PreviewOut { batchId: string; batch: BulkBatchView; ignored: string[] }

interface RowDraft {
  staffId: string
  requestId: string | null
  bedId: string | null
  arrivalDate: string | null
  endDate: string | null
  stayType: RequestRow['stayType'] | null
  outcome: BulkRowOutcome
  message: string
}

const UNAVAILABLE = ['blocked', 'under_maintenance', 'archived'] as const

/** Why no bed fits: either nothing is free at all for those dates, or beds are free but this person may not take them. */
async function explainNoBed(tx: Tx, r: RequestRow, taken: string[], now: Date): Promise<{ outcome: BulkRowOutcome; message: string }> {
  const period = claimPeriod(r.arrivalDate, r.endDate ?? undefined)
  // Beds free for these dates, whether or not an earlier row in this batch has been matched to them.
  const free = await tx.select({ bedId: bed.id }).from(bed).innerJoin(room, eq(room.id, bed.roomId)).where(and(
    eq(bed.siteId, r.siteId), isNull(bed.archivedAt), isNull(room.archivedAt), notInArray(bed.state, [...UNAVAILABLE]),
    sql`NOT EXISTS (SELECT 1 FROM ${bedClaim} WHERE ${bedClaim.bedId} = ${bed.id} AND ${bedClaim.releasedAt} IS NULL AND ${bedClaim.period} && ${period}::daterange)`,
  )).limit(40)
  if (free.length === 0) return { outcome: 'conflict', message: 'No free bed for these dates. The waitlist is the next step' }
  let first: Awaited<ReturnType<typeof checkEligibility>>
  for (const f of free) {
    const e = await checkEligibility(tx, r.staffId, f.bedId, now, { requestId: r.id })
    first ??= e
    if (e?.ok) {
      // A bed suits this person; it is only unavailable because an earlier row in this batch has it.
      return { outcome: 'conflict', message: taken.includes(f.bedId) ? 'The free beds that suit this person are matched to others in this batch. The waitlist is the next step' : 'No free bed for these dates. The waitlist is the next step' }
    }
  }
  const reasons = first?.reasons.join('; ') || 'No eligible bed'
  return { outcome: 'not_eligible', message: first?.exceptionable ? `${reasons}. A Policy Approver exception on the request would allow it` : reasons }
}

/** Builds a stored preview. Writes the batch and its rows only: no reservation, no claim, no change to any request. */
export function previewBulkAllocation(rc: RequestContext, i: PreviewBulkInput): Promise<Result<PreviewOut>> {
  return runCommand(rc, async c => {
    const denied = authorize(c, 'checkin_checkout.allocate_bulk', { siteId: i.siteId })
    if (denied) return denied
    const [s] = await c.tx.select({ id: site.id, name: site.name, archivedAt: site.archivedAt }).from(site).where(eq(site.id, i.siteId))
    if (!s || s.archivedAt) return fail.invalid('That site is not available', { siteId: 'Choose an active site' })

    const ignored: string[] = []
    const drafts: RowDraft[] = []
    const used: string[] = []

    // 1. Which requests?
    let reqs: RequestRow[] = []
    const byEmployee = i.employeeIds && i.employeeIds.length > 0
    if (i.requestIds?.length) {
      reqs = await c.tx.select().from(accommodationRequest).where(and(eq(accommodationRequest.siteId, i.siteId), inArray(accommodationRequest.id, i.requestIds))).orderBy(asc(accommodationRequest.createdAt))
      for (const id of i.requestIds) if (!reqs.some(r => r.id === id)) ignored.push(`Request ${id.slice(0, 8)} is not at this site`)
    }
    if (byEmployee) {
      const keys = i.employeeIds!.map(e => e.trim().toLowerCase())
      const people = await c.tx.select({ id: staffProfile.id, employeeId: staffProfile.employeeId }).from(staffProfile).where(inArray(sql`lower(btrim(${staffProfile.employeeId}))`, keys))
      for (const k of keys) if (!people.some(p => p.employeeId.trim().toLowerCase() === k)) ignored.push(`${k.toUpperCase()}: no staff member has that employee ID`)
      if (people.length) {
        const theirs = await c.tx.select().from(accommodationRequest).where(and(
          eq(accommodationRequest.siteId, i.siteId), inArray(accommodationRequest.staffId, people.map(p => p.id)),
          inArray(accommodationRequest.status, ['submitted', 'pending_approval', 'changes_requested']),
        )).orderBy(asc(accommodationRequest.createdAt))
        for (const t of theirs) if (!reqs.some(r => r.id === t.id)) reqs.push(t)
        for (const p of people) {
          if (!reqs.some(r => r.staffId === p.id)) {
            drafts.push({ staffId: p.id, requestId: null, bedId: null, arrivalDate: null, endDate: null, stayType: null, outcome: 'no_request', message: 'No open request at this site. Ask the person (or Reception) to file one first' })
          }
        }
      }
    }
    if (!i.requestIds?.length && !byEmployee) {
      reqs = await c.tx.select().from(accommodationRequest).where(and(eq(accommodationRequest.siteId, i.siteId), eq(accommodationRequest.status, 'submitted')))
        .orderBy(asc(accommodationRequest.createdAt)).limit(MAX_ROWS)
    }
    if (reqs.length + drafts.length === 0) return fail.invalid('There is nothing to allocate', { requestIds: 'No open requests match' })

    // 2. Match each request to a bed. Each bed is used once in the batch.
    for (const r of reqs) {
      const base = { staffId: r.staffId, requestId: r.id, arrivalDate: r.arrivalDate, endDate: r.endDate, stayType: r.stayType }
      if (r.status !== 'submitted') {
        drafts.push({ ...base, bedId: null, outcome: 'conflict', message: wrongState(r, 'allocated').reason })
        continue
      }
      if (r.staffId === c.actor.staffId || (r.onBehalf && r.submittedBy === c.user.id)) {
        drafts.push({ ...base, bedId: null, outcome: 'conflict', message: 'You cannot allocate a bed on a request that is yours or that you filed: a different Accommodation Admin does this one (D-26)' })
        continue
      }
      const [pick] = await suggestBeds(c.tx, { staffId: r.staffId, siteId: r.siteId, from: r.arrivalDate, to: r.endDate ?? undefined, limit: 1, excludeBedIds: used, requestId: r.id, now: c.now })
      if (pick) {
        used.push(pick.bedId)
        drafts.push({ ...base, bedId: pick.bedId, outcome: 'new', message: `Bed ${pick.code}, Room ${pick.roomName}` })
      } else {
        const why = await explainNoBed(c.tx, r, used, c.now)
        drafts.push({ ...base, bedId: null, ...why })
      }
    }

    // 3. Store the preview.
    const [batch] = await c.tx.insert(bulkAllocationBatch).values({ siteId: i.siteId, createdBy: c.user.id, status: 'previewed' }).returning({ id: bulkAllocationBatch.id })
    await c.tx.insert(bulkAllocationRow).values(drafts.map((d, n) => ({
      batchId: batch.id, position: n + 1, staffId: d.staffId, requestId: d.requestId, bedId: d.bedId, arrivalDate: d.arrivalDate, endDate: d.endDate,
      stayType: d.stayType, outcome: d.outcome, message: d.message, status: d.outcome === 'new' ? ('pending' as const) : ('skipped' as const),
    })))
    await audit(c, {
      action: 'requests.bulk.previewed', entityType: 'bulk_allocation', entityId: batch.id, siteId: i.siteId,
      after: { rows: drafts.length, ready: drafts.filter(d => d.outcome === 'new').length, conflicts: drafts.filter(d => d.outcome === 'conflict').length, notEligible: drafts.filter(d => d.outcome === 'not_eligible').length },
    })
    const view = await getBulkBatch(c.tx, c.actor, batch.id)
    return ok({ batchId: batch.id, batch: view!, ignored }, `Preview ready: ${drafts.filter(d => d.outcome === 'new').length} of ${drafts.length} can be reserved. Nothing has been reserved yet.`)
  })
}

/* ---------------- confirm ---------------- */

export const confirmInput = z.object({ batchId: idSchema })

type RowResult = { done: true; reservationId: string } | { done: false; skipped: true } | { done: false; failure: Failure }

/** One row, one transaction. Returns what happened; a refusal rolls back everything this row did. */
async function confirmRow(rc: RequestContext, rowId: string): Promise<RowResult> {
  const r = await runCommand<RowResult>(rc, async c => {
    const [row] = await c.tx.select().from(bulkAllocationRow).where(eq(bulkAllocationRow.id, rowId)).for('update')
    if (!row) return fail.notFound()
    if (row.status === 'done' || row.status === 'skipped' || !row.requestId || !row.bedId) return ok<RowResult>({ done: false, skipped: true })
    const res = await approveIn(c, { requestId: row.requestId, bedId: row.bedId, source: 'bulk' })
    if (!res.ok) return res
    await c.tx.update(bulkAllocationRow).set({
      status: 'done', reservationId: res.data.reservationId, attempts: row.attempts + 1,
      resultMessage: res.data.repeated ? 'Already reserved with this bed' : `Reserved ${res.data.bedLabel}`,
    }).where(eq(bulkAllocationRow.id, rowId))
    return ok<RowResult>({ done: true, reservationId: res.data.reservationId })
  })
  if (r.ok) return r.data
  // The row's transaction rolled back; record why in a small transaction of its own (never over a row that is already done).
  await runCommand(rc, async c => {
    await c.tx.update(bulkAllocationRow).set({
      status: 'failed', attempts: sql`${bulkAllocationRow.attempts} + 1`,
      resultMessage: [r.reason, r.next && `Next: ${r.next}`].filter(Boolean).join(' · '),
    }).where(and(eq(bulkAllocationRow.id, rowId), inArray(bulkAllocationRow.status, ['pending', 'failed'])))
    return ok(undefined)
  })
  return { done: false, failure: r }
}

export interface ConfirmOut { batch: BulkBatchView; attempted: number; reserved: number; failed: number; alreadyDone: number }

/** Confirms a stored preview row by row; safe to call again (and concurrently): done rows are skipped, failed rows retried. */
export async function confirmBulkAllocation(rc: RequestContext, i: z.infer<typeof confirmInput>): Promise<Result<ConfirmOut>> {
  // Gate: the batch must be one this actor may confirm and still have something to do.
  const gate = await runCommand(rc, async c => {
    const [b] = await c.tx.select().from(bulkAllocationBatch).where(and(eq(bulkAllocationBatch.id, i.batchId), isNull(bulkAllocationBatch.archivedAt)))
    if (!b) return fail.notFound()
    const denied = authorize(c, 'checkin_checkout.allocate_bulk', { siteId: b.siteId })
    if (denied) return denied
    if (b.status === 'discarded') return failure('conflict', 'This preview was discarded', { owner: 'Accommodation Admin', next: 'Make a new preview' })
    const rows = await c.tx.select({ id: bulkAllocationRow.id, status: bulkAllocationRow.status, outcome: bulkAllocationRow.outcome, position: bulkAllocationRow.position }).from(bulkAllocationRow)
      .where(eq(bulkAllocationRow.batchId, b.id)).orderBy(asc(bulkAllocationRow.position))
    return ok({ siteId: b.siteId, todo: rows.filter(r => r.outcome === 'new' && (r.status === 'pending' || r.status === 'failed')).map(r => r.id), done: rows.filter(r => r.status === 'done').length })
  })
  if (!gate.ok) return gate

  let reserved = 0, failed = 0
  for (const rowId of gate.data.todo) {
    const r = await confirmRow(rc, rowId)
    if (r.done) reserved++
    else if (!('skipped' in r)) failed++
  }

  // Settle the batch status from the rows as they are now.
  const view = await runCommand(rc, async c => {
    const [b] = await c.tx.select().from(bulkAllocationBatch).where(eq(bulkAllocationBatch.id, i.batchId)).for('update')
    const rows = await c.tx.select({ status: bulkAllocationRow.status, outcome: bulkAllocationRow.outcome }).from(bulkAllocationRow).where(eq(bulkAllocationRow.batchId, i.batchId))
    const open = rows.some(r => r.outcome === 'new' && (r.status === 'pending' || r.status === 'failed'))
    const status = open ? 'partial' : 'confirmed'
    if (gate.data.todo.length > 0 || b.status === 'previewed') {
      await c.tx.update(bulkAllocationBatch).set({ status, confirmedBy: c.user.id, confirmedAt: b.confirmedAt ?? c.now }).where(eq(bulkAllocationBatch.id, i.batchId))
      await audit(c, {
        action: 'requests.bulk.confirmed', entityType: 'bulk_allocation', entityId: i.batchId, siteId: gate.data.siteId,
        before: { status: b.status }, after: { status, attempted: gate.data.todo.length, reserved, failed },
      })
    }
    return ok((await getBulkBatch(c.tx, c.actor, i.batchId))!)
  })
  if (!view.ok) return view
  const msg = failed === 0
    ? (gate.data.todo.length === 0 ? 'Nothing left to do: every reservable row is already done.' : `${reserved} reserved.`)
    : `${reserved} reserved, ${failed} could not be done. Fix the reason shown and confirm again: only the failed rows are retried.`
  return ok({ batch: view.data, attempted: gate.data.todo.length, reserved, failed, alreadyDone: gate.data.done }, msg)
}

/** Throws a preview away without reserving anything. Allowed only before it has been confirmed. */
export function discardBulkAllocation(rc: RequestContext, i: z.infer<typeof confirmInput>): Promise<Result<{ batchId: string; status: 'discarded' }>> {
  return runCommand(rc, async c => {
    const [b] = await c.tx.select().from(bulkAllocationBatch).where(and(eq(bulkAllocationBatch.id, i.batchId), isNull(bulkAllocationBatch.archivedAt))).for('update')
    if (!b) return fail.notFound()
    const denied = authorize(c, 'checkin_checkout.allocate_bulk', { siteId: b.siteId })
    if (denied) return denied
    if (b.status === 'discarded') return ok({ batchId: b.id, status: 'discarded' as const }, 'Already discarded.')
    if (b.status !== 'previewed') return failure('conflict', 'Some of this batch has already been reserved, so it cannot be discarded', { owner: 'Accommodation Admin', next: 'Cancel individual reservations if needed' })
    await c.tx.update(bulkAllocationBatch).set({ status: 'discarded' }).where(eq(bulkAllocationBatch.id, b.id))
    await audit(c, { action: 'requests.bulk.discarded', entityType: 'bulk_allocation', entityId: b.id, siteId: b.siteId, before: { status: 'previewed' }, after: { status: 'discarded' } })
    return ok({ batchId: b.id, status: 'discarded' as const }, 'Preview discarded.')
  })
}
