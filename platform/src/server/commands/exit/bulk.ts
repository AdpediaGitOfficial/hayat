/**
 * Bulk exit (D-38, retry-safe).
 *
 *   previewBulkExit   reads a list of employee IDs (or CSV text), decides each row's outcome (will be marked, already Left, not found,
 *                     blocked with a reason) and STORES it as a batch. Nothing about any person changes.
 *   confirmBulkExit   re-confirms the password ONCE, then works the stored rows one by one. Each row is its own transaction through
 *                     markLeftIn(), the same path a single Mark as Left takes, so scope, separation of duties and the Super Admin guard
 *                     apply to every row. A failed row leaves no trace except its message; confirming again skips the rows that are
 *                     done and retries only the ones that failed.
 */
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { z } from 'zod'
import { staffProfile } from '@/server/db/schema'
import { exitBulkBatch, exitBulkRow, type ExitRowOutcome } from '@/server/db/schema.exit'
import { audit } from '@/server/audit'
import { authorize, notSelf } from '@/server/command/authorize'
import { runCommand } from '@/server/command/run'
import type { CommandContext, RequestContext } from '@/server/command/context'
import { fail, failure, ok, type Failure, type Result } from '@/server/command/result'
import { confirmPassword } from '@/server/auth/reauth'
import { isFullSuperAdmin, loadTarget, lastSuperAdminFailure, targetManageableBy } from '@/server/commands/access/guards'
import { describeImpact, exitImpact } from '@/server/queries/exit/impact'
import { getExitBatch, type ExitBatchView } from '@/server/queries/exit/bulk'
import { markLeftIn } from './markLeft'
import { authorizeAtSite, exitSiteId, holdsSuperAdmin, idSchema, latestCaseFor, loadPerson, reasonSchema, OPEN_CASE_STATUSES } from './shared'

export const MAX_ROWS = 200

export const previewInput = z.object({
  /** Employee IDs, one per entry. */
  employeeIds: z.array(z.string().trim().min(1).max(60)).max(MAX_ROWS).optional(),
  /** Or CSV text: the first cell of each line is the employee ID; a header line is ignored. */
  csv: z.string().max(100_000).optional(),
  effectiveDate: z.iso.date('Use a date like 2026-11-30'),
  reason: reasonSchema,
})
export type PreviewExitInput = z.infer<typeof previewInput>

/** Employee IDs from a pasted list or CSV, in order, without blanks or repeats. */
export function parseEmployeeIds(i: Pick<PreviewExitInput, 'employeeIds' | 'csv'>): { ids: string[]; duplicates: string[] } {
  const raw: string[] = [...(i.employeeIds ?? [])]
  if (i.csv) {
    const lines = i.csv.replace(/^﻿/, '').split(/\r?\n/)
    lines.forEach((line, n) => {
      const first = line.split(/[,;\t]/)[0]?.trim().replace(/^"(.*)"$/, '$1').trim() ?? ''
      if (!first) return
      if (n === 0 && /^(employee[\s_-]*id|emp[\s_-]*id|id)$/i.test(first)) return
      raw.push(first)
    })
  }
  const seen = new Set<string>()
  const ids: string[] = []
  const duplicates: string[] = []
  for (const r of raw.map(x => x.trim()).filter(Boolean)) {
    const k = r.toLowerCase()
    if (seen.has(k)) { duplicates.push(r); continue }
    seen.add(k)
    ids.push(r)
  }
  return { ids, duplicates }
}

interface RowDraft { employeeId: string; staffId: string | null; outcome: ExitRowOutcome; message: string }

/** Decides one row the way a single Mark as Left would, without changing anything. Out of scope looks exactly like "not found". */
async function judge(c: CommandContext, employeeId: string): Promise<RowDraft> {
  const key = employeeId.trim().toLowerCase()
  const notFound: RowDraft = { employeeId, staffId: null, outcome: 'not_found', message: 'No staff member with that employee ID' }
  const [hit] = await c.tx.select({ id: staffProfile.id }).from(staffProfile).where(and(sql`lower(btrim(${staffProfile.employeeId})) = ${key}`, isNull(staffProfile.archivedAt))).limit(1)
  if (!hit) return notFound
  const p = await loadPerson(c.tx, hit.id)
  if (!p) return notFound
  const earlier = p.employmentStatus === 'left' ? await latestCaseFor(c.tx, p.staffId) : undefined
  const siteId = (await exitSiteId(c.tx, p.staffId)) ?? earlier?.siteId ?? undefined
  if (authorizeAtSite(c, 'exit_clearance.mark_left', siteId)) return notFound
  const base = { employeeId: p.employeeId, staffId: p.staffId }
  if (p.employmentStatus === 'left') {
    return { ...base, outcome: 'already_left', message: `${p.fullName} is already marked as Left${p.leftEffective ? ` (effective ${p.leftEffective})` : ''}` }
  }
  if (notSelf(c, p.staffId, 'mark an employee as Left')) return { ...base, outcome: 'blocked', message: `${p.fullName}: you cannot mark yourself as Left. Owner: another Accommodation Admin or Super Admin` }
  if (p.userId) {
    const t = await loadTarget(c.tx, p.userId)
    if (t && t.adminType && !isFullSuperAdmin(c.actor) && !targetManageableBy(c.actor, t)) {
      return { ...base, outcome: 'blocked', message: `${p.fullName} holds an administrator role: only a Super Admin can mark them as Left. Owner: Super Admin` }
    }
    if (await holdsSuperAdmin(c.tx, p.userId) && await lastSuperAdminFailure(c.tx, p.userId)) {
      return { ...base, outcome: 'blocked', message: `${p.fullName} is the last active Super Admin and can never be removed (D-27). Owner: Super Admin. Next: appoint another Super Admin first` }
    }
  }
  const open = await latestCaseFor(c.tx, p.staffId)
  if (open && OPEN_CASE_STATUSES.includes(open.status as (typeof OPEN_CASE_STATUSES)[number])) {
    return { ...base, outcome: 'blocked', message: `${p.fullName} still has an open clearance case from an earlier exit. Owner: Accommodation Admin. Next: close it first` }
  }
  const impact = await exitImpact(c.tx, p.staffId)
  return { ...base, outcome: 'will_mark', message: `${p.fullName}: ${describeImpact(impact).slice(0, -1).join(' ')}` }
}

export interface PreviewExitOut { batchId: string; batch: ExitBatchView; duplicates: string[] }

export function previewBulkExit(rc: RequestContext, i: PreviewExitInput): Promise<Result<PreviewExitOut>> {
  return runCommand(rc, async c => {
    // A person who may never mark anyone as Left is refused before a batch (and an audit row) is written; the rows are then judged per site.
    const denied = authorize(c, 'exit_clearance.mark_left')
    if (denied) return denied
    const { ids, duplicates } = parseEmployeeIds(i)
    if (ids.length === 0) return fail.invalid('There is nobody to mark as Left', { employeeIds: 'Paste at least one employee ID' })
    if (ids.length > MAX_ROWS) return fail.invalid(`At most ${MAX_ROWS} people at a time`, { employeeIds: `Split the list: ${ids.length} is too many` })
    const drafts: RowDraft[] = []
    for (const id of ids) drafts.push(await judge(c, id))
    const [batch] = await c.tx.insert(exitBulkBatch).values({ createdBy: c.user.id, effectiveDate: i.effectiveDate, reason: i.reason, status: 'previewed' }).returning({ id: exitBulkBatch.id })
    await c.tx.insert(exitBulkRow).values(drafts.map((d, n) => ({
      batchId: batch.id, position: n + 1, employeeId: d.employeeId, staffId: d.staffId, outcome: d.outcome, message: d.message,
      status: d.outcome === 'will_mark' ? ('pending' as const) : ('skipped' as const),
    })))
    const tally = (o: ExitRowOutcome) => drafts.filter(d => d.outcome === o).length
    // The preview itself changes nothing about any person; this audit row records that someone looked and what they saw.
    await audit(c, {
      action: 'exit.bulk.previewed', entityType: 'exit_bulk', entityId: batch.id, reason: i.reason,
      after: { rows: drafts.length, willMark: tally('will_mark'), alreadyLeft: tally('already_left'), notFound: tally('not_found'), blocked: tally('blocked'), effectiveDate: i.effectiveDate },
    })
    const view = await getExitBatch(c.tx, c.actor, c.user.id, batch.id)
    return ok({ batchId: batch.id, batch: view!, duplicates }, `Preview ready: ${tally('will_mark')} of ${drafts.length} will be marked as Left. Nobody has been changed yet.`)
  })
}

/* ---------------- confirm ---------------- */

export const confirmInput = z.object({ batchId: idSchema, confirmPassword: z.string().max(200).optional() })

type RowResult = { done: true } | { done: false; skipped: true } | { done: false; failure: Failure }

async function confirmRow(rc: RequestContext, rowId: string): Promise<RowResult> {
  const r = await runCommand<RowResult>(rc, async c => {
    const [row] = await c.tx.select().from(exitBulkRow).where(eq(exitBulkRow.id, rowId)).for('update')
    if (!row) return fail.notFound()
    if (row.status === 'done' || row.status === 'skipped' || !row.staffId) return ok<RowResult>({ done: false, skipped: true })
    const [batch] = await c.tx.select().from(exitBulkBatch).where(eq(exitBulkBatch.id, row.batchId))
    const res = await markLeftIn(c, { staffId: row.staffId, effectiveDate: batch.effectiveDate, reason: batch.reason }, { passwordChecked: true })
    if (!res.ok) return res
    await c.tx.update(exitBulkRow).set({
      status: 'done', caseId: res.data.caseId, attempts: row.attempts + 1,
      resultMessage: res.data.repeated ? 'Already marked as Left; clearance case kept' : `Marked as Left. Clearance case opened, due ${res.data.dueDate}`,
    }).where(eq(exitBulkRow.id, rowId))
    return ok<RowResult>({ done: true })
  })
  if (r.ok) return r.data
  // The row's transaction rolled back; say why in a small transaction of its own (never over a row that is already done).
  await runCommand(rc, async c => {
    await c.tx.update(exitBulkRow).set({
      status: 'failed', attempts: sql`${exitBulkRow.attempts} + 1`,
      resultMessage: [r.reason, r.owner && `Owner: ${r.owner}`, r.next && `Next: ${r.next}`].filter(Boolean).join(' · '),
    }).where(and(eq(exitBulkRow.id, rowId), inArray(exitBulkRow.status, ['pending', 'failed'])))
    return ok(undefined)
  })
  return { done: false, failure: r }
}

export interface ConfirmExitOut { batch: ExitBatchView; attempted: number; marked: number; failed: number; alreadyDone: number }

/** Confirms a stored preview row by row; safe to call again (and concurrently): done rows are skipped, failed rows retried. */
export async function confirmBulkExit(rc: RequestContext, i: z.infer<typeof confirmInput>): Promise<Result<ConfirmExitOut>> {
  // Gate: my batch, still to do, and the password re-confirmed once for the whole batch.
  const gate = await runCommand(rc, async c => {
    const [b] = await c.tx.select().from(exitBulkBatch).where(and(eq(exitBulkBatch.id, i.batchId), isNull(exitBulkBatch.archivedAt)))
    if (!b || b.createdBy !== c.user.id) return fail.notFound()
    if (b.status === 'discarded') return failure('conflict', 'This preview was discarded', { owner: 'Accommodation Admin', next: 'Make a new preview' })
    const rows = await c.tx.select({ id: exitBulkRow.id, status: exitBulkRow.status, outcome: exitBulkRow.outcome }).from(exitBulkRow).where(eq(exitBulkRow.batchId, b.id)).orderBy(asc(exitBulkRow.position))
    const todo = rows.filter(r => r.outcome === 'will_mark' && (r.status === 'pending' || r.status === 'failed')).map(r => r.id)
    if (todo.length > 0) {
      const bad = await confirmPassword(c, i.confirmPassword)
      if (bad) return bad
    }
    return ok({ todo, done: rows.filter(r => r.status === 'done').length })
  })
  if (!gate.ok) return gate

  let marked = 0, failed = 0
  for (const rowId of gate.data.todo) {
    const r = await confirmRow(rc, rowId)
    if (r.done) marked++
    else if (!('skipped' in r)) failed++
  }

  const view = await runCommand(rc, async c => {
    const [b] = await c.tx.select().from(exitBulkBatch).where(eq(exitBulkBatch.id, i.batchId)).for('update')
    const rows = await c.tx.select({ status: exitBulkRow.status, outcome: exitBulkRow.outcome }).from(exitBulkRow).where(eq(exitBulkRow.batchId, i.batchId))
    const open = rows.some(r => r.outcome === 'will_mark' && (r.status === 'pending' || r.status === 'failed'))
    const status = open ? 'partial' : 'confirmed'
    if (gate.data.todo.length > 0 || b.status === 'previewed') {
      await c.tx.update(exitBulkBatch).set({ status, confirmedBy: c.user.id, confirmedAt: b.confirmedAt ?? c.now }).where(eq(exitBulkBatch.id, i.batchId))
      await audit(c, {
        action: 'exit.bulk.confirmed', entityType: 'exit_bulk', entityId: i.batchId, reason: b.reason,
        before: { status: b.status }, after: { status, attempted: gate.data.todo.length, marked, failed },
      })
    }
    return ok((await getExitBatch(c.tx, c.actor, c.user.id, i.batchId))!)
  })
  if (!view.ok) return view
  const msg = failed === 0
    ? (gate.data.todo.length === 0 ? 'Nothing left to do: every row that could be marked is already done.' : `${marked} marked as Left.`)
    : `${marked} marked as Left, ${failed} could not be done. Fix the reason shown and confirm again: only the failed rows are retried.`
  return ok({ batch: view.data, attempted: gate.data.todo.length, marked, failed, alreadyDone: gate.data.done }, msg)
}

/** Throws a preview away. Allowed only before anything was confirmed. */
export function discardBulkExit(rc: RequestContext, i: { batchId: string }): Promise<Result<{ batchId: string; status: 'discarded' }>> {
  return runCommand(rc, async c => {
    const [b] = await c.tx.select().from(exitBulkBatch).where(and(eq(exitBulkBatch.id, i.batchId), isNull(exitBulkBatch.archivedAt))).for('update')
    if (!b || b.createdBy !== c.user.id) return fail.notFound()
    if (b.status === 'discarded') return ok({ batchId: b.id, status: 'discarded' as const }, 'Already discarded.')
    if (b.status !== 'previewed') return failure('conflict', 'Some of this batch has already been marked as Left, so it cannot be discarded', { owner: 'Accommodation Admin', next: 'Open the clearance cases' })
    await c.tx.update(exitBulkBatch).set({ status: 'discarded' }).where(eq(exitBulkBatch.id, b.id))
    await audit(c, { action: 'exit.bulk.discarded', entityType: 'exit_bulk', entityId: b.id, before: { status: 'previewed' }, after: { status: 'discarded' } })
    return ok({ batchId: b.id, status: 'discarded' as const }, 'Preview discarded.')
  })
}
