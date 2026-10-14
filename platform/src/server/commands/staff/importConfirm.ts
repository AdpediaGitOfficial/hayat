import { z } from 'zod'
import { and, asc, eq, sql } from 'drizzle-orm'
import { runCommand } from '@/server/command/run'
import { fail, ok, type Result } from '@/server/command/result'
import type { CommandContext, RequestContext } from '@/server/command/context'
import { auditEvent, staffProfile } from '@/server/db/schema'
import { importBatch, importRow } from '@/server/db/schema.staff'
import { batchVisibility, blockedFor, importPolicy } from '@/server/queries/staff/imports'
import { isUuid, requireDirectory } from './guard'
import type { StaffValues } from './fields'

export const input = z.object({ batchId: z.string().uuid() })
export type ConfirmInput = z.infer<typeof input>

export interface ImportResult {
  batchId: string
  policy: 'save_valid' | 'all_or_nothing'
  total: number
  created: number
  rejected: number
  /** Rejected, split by why (they add up to `rejected`). */
  duplicate: number
  invalid: number
  rejectedFileAvailable: boolean
}

const CHUNK = 400
/** A typed array parameter. (Drizzle spreads a bare JS array into a tuple, so build ARRAY[...] from single parameters.) */
const pgArray = (items: readonly (string | null)[], type: 'uuid' | 'text') =>
  sql`ARRAY[${sql.join(items.map(i => sql`${i}`), sql`, `)}]::${sql.raw(type)}[]`
const lowerKey = sql<string>`lower(btrim(${staffProfile.employeeId}))`

/**
 * Step 2 of the import (AT-005). In ONE transaction:
 *  - the batch row is locked and must still be 'previewed' (a second confirm, or a simultaneous one, finds it confirmed and is refused),
 *  - every previewed-new row is saved with INSERT .. ON CONFLICT DO NOTHING, so a row whose employee ID was taken since the
 *    preview (by a manual create, another import) is rejected with that reason instead of failing the batch or doubling up,
 *  - under the all-or-nothing policy any rejected row, at preview or now, saves nothing at all,
 *  - the batch, every row's outcome, one audit event for the batch and one per created profile are written together.
 * Created + rejected always equals the number of rows in the file.
 */
export async function confirmStaffImport(rc: RequestContext, raw: ConfirmInput): Promise<Result<ImportResult>> {
  return runCommand(rc, async c => {
    const denied = requireDirectory(c, 'staff_directory.import_csv')
    if (denied) return denied
    if (!isUuid(raw.batchId)) return fail.notFound()

    const vis = batchVisibility({ actor: c.actor, userId: c.user.id })
    if (vis === 'none') return fail.notFound()
    const [batch] = await c.tx.select().from(importBatch).where(and(eq(importBatch.id, raw.batchId), vis)).for('update')
    if (!batch) return fail.notFound()

    if (batch.status === 'confirmed') {
      const result = resultOf(batch)
      return {
        ...fail.conflict(
          `This import was already confirmed: ${batch.createdCount} saved, ${batch.rejectedCount} rejected. Confirming again would not save anything more`,
          'Accommodation Admin', 'Download the rejected rows if any are left to fix, then upload a corrected file', { result },
        ),
      }
    }

    const policy = await importPolicy(c.tx)
    const blocked = blockedFor(policy, batch)
    if (blocked) return fail.conflict(blocked.why, blocked.owner, blocked.next)

    const rows = await c.tx.select().from(importRow).where(eq(importRow.batchId, batch.id)).orderBy(asc(importRow.rowNo))
    const fresh = rows.filter(r => r.classification === 'new')

    // Save in employee-ID order so two overlapping imports queue on each other instead of deadlocking.
    const ordered = [...fresh].sort((a, b) => (a.employeeKey! < b.employeeKey! ? -1 : a.employeeKey! > b.employeeKey! ? 1 : a.rowNo - b.rowNo))
    const createdBy = new Map<string, string>() // employee key -> new staff id
    const createdRows = new Map<string, { rowNo: number; values: StaffValues }>() // staff id -> row
    for (let i = 0; i < ordered.length; i += CHUNK) {
      const slice = ordered.slice(i, i + CHUNK)
      const inserted = await c.tx.insert(staffProfile).values(slice.map(r => {
        const v = r.data as unknown as StaffValues
        return { ...v, source: 'csv' as const }
      })).onConflictDoNothing().returning({ id: staffProfile.id, k: lowerKey })
      for (const s of inserted) createdBy.set(s.k, s.id)
    }

    const refusedNow = fresh.filter(r => !createdBy.has(r.employeeKey!))
    if (policy === 'all_or_nothing' && refusedNow.length > 0) {
      // A row became a duplicate after the preview. Everything saved so far in this transaction is rolled back with the failure.
      return fail.conflict(
        `${refusedNow.length} row${refusedNow.length === 1 ? ' was' : 's were'} taken by another change since the preview (for example row ${refusedNow[0].rowNo}), and the import policy is all-or-nothing, so nothing was saved`,
        'Accommodation Admin', 'Upload the file again to get a fresh preview',
      )
    }

    // Decide every row.
    const decided: { id: string; outcome: 'created' | 'rejected'; reason: string | null; staffId: string | null }[] = []
    for (const r of rows) {
      if (r.classification !== 'new') {
        decided.push({ id: r.id, outcome: 'rejected', reason: r.reasons.join('; ') || 'Rejected at preview', staffId: null })
      } else {
        const sid = createdBy.get(r.employeeKey!)
        if (sid) { decided.push({ id: r.id, outcome: 'created', reason: null, staffId: sid }); createdRows.set(sid, { rowNo: r.rowNo, values: r.data as unknown as StaffValues }) }
        else decided.push({ id: r.id, outcome: 'rejected', reason: 'Employee ID was taken by another change after the preview. Records are never merged automatically', staffId: null })
      }
    }
    for (let i = 0; i < decided.length; i += 1000) {
      const part = decided.slice(i, i + 1000)
      await c.tx.execute(sql`
        UPDATE import_row AS r SET outcome = v.outcome, outcome_reason = v.reason, staff_id = v.staff_id
        FROM (SELECT unnest(${pgArray(part.map(d => d.id), 'uuid')}) AS id, unnest(${pgArray(part.map(d => d.outcome), 'text')}) AS outcome,
                     unnest(${pgArray(part.map(d => d.reason), 'text')}) AS reason, unnest(${pgArray(part.map(d => d.staffId), 'uuid')}) AS staff_id) AS v
        WHERE r.id = v.id`)
    }

    const created = decided.filter(d => d.outcome === 'created').length
    const rejected = decided.length - created
    const duplicate = rows.filter(r => r.classification === 'duplicate').length + refusedNow.length
    const invalid = rows.filter(r => r.classification === 'invalid').length

    await c.tx.update(importBatch).set({
      status: 'confirmed', policy, createdCount: created, rejectedCount: rejected, confirmedBy: c.user.id, confirmedAt: c.now, updatedAt: c.now,
    }).where(eq(importBatch.id, batch.id))

    // One event for the batch with the real counts, then one per created profile.
    const base = { actorUserId: c.user.id, actorRole: c.actor.role, requestId: c.requestId, ip: c.ip ?? null }
    await c.tx.insert(auditEvent).values({
      ...base, action: 'staff.import.confirmed', entityType: 'import_batch', entityId: batch.id,
      after: { total: decided.length, created, rejected, duplicate, invalid, policy, fileName: batch.fileName },
    })
    const events = [...createdRows.entries()].sort((a, b) => a[1].rowNo - b[1].rowNo)
    for (let i = 0; i < events.length; i += CHUNK) {
      await c.tx.insert(auditEvent).values(events.slice(i, i + CHUNK).map(([sid, r]) => ({
        ...base, action: 'staff.created', entityType: 'staff_profile', entityId: sid,
        after: { employeeId: r.values.employeeId, fullName: r.values.fullName, department: r.values.department, source: 'csv', importBatchId: batch.id, row: r.rowNo },
      })))
    }

    const result: ImportResult = { batchId: batch.id, policy, total: decided.length, created, rejected, duplicate, invalid, rejectedFileAvailable: rejected > 0 }
    return ok(result, rejected === 0 ? `Saved ${created} staff` : `Saved ${created} staff. ${rejected} row${rejected === 1 ? ' was' : 's were'} rejected`)
  })
}

function resultOf(b: typeof importBatch.$inferSelect): ImportResult {
  return {
    batchId: b.id, policy: b.policy ?? 'save_valid', total: b.totalRows, created: b.createdCount ?? 0, rejected: b.rejectedCount ?? 0,
    duplicate: b.duplicateRows, invalid: b.invalidRows, rejectedFileAvailable: (b.rejectedCount ?? 0) > 0,
  }
}

export type { CommandContext }
