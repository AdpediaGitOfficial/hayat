/**
 * Import batches as the screens and the API show them. A batch belongs to the person who previewed it; a Super Admin may
 * see every batch. Anyone else gets "not found", exactly like a batch that does not exist. Reading also needs the
 * import_csv action with a usable scope.
 */
import { and, asc, eq, or, sql, type SQL } from 'drizzle-orm'
import type { Db } from '@/server/db/client'
import { scopeFilter, type Actor } from '@/server/policy'
import { importBatch, importRow } from '@/server/db/schema.staff'
import { getConfig } from '@/server/config/registry'
import type { ImportClassification, ImportOutcome, ImportPolicy } from '@/server/db/schema.staff'

type Reader = Pick<Db, 'select'>
export interface Viewer { actor: Actor; userId: string }

export interface ImportRowView {
  rowNo: number
  classification: ImportClassification
  /** Set once confirmed: what actually happened to the row. */
  outcome: ImportOutcome | null
  reasons: string[]
  warnings: string[]
  employeeId: string
  fullName: string
  department: string
}

export interface ImportBatchView {
  id: string
  status: 'previewed' | 'confirmed'
  fileName: string | null
  createdAt: Date
  confirmedAt: Date | null
  policy: ImportPolicy
  summary: {
    total: number; new: number; duplicate: number; invalid: number; withWarnings: number
    /** Only after confirm: created + rejected = total. */
    created: number | null; rejected: number | null
  }
  ignoredColumns: string[]
  rows: ImportRowView[]
  /** For a previewed batch: may it be confirmed now, and if not, why/who/what next (D-93). */
  canConfirm: boolean
  blocked?: { why: string; owner: string; next: string }
}

/** Rows of the batch that are, or will be, rejected: refused at preview, or refused at confirm. */
export const isRejected = (r: { classification: string; outcome: string | null }) => r.outcome === 'rejected' || (r.outcome === null && r.classification !== 'new')

export function batchVisibility(viewer: Viewer): SQL | undefined | 'none' {
  if (scopeFilter(viewer.actor, 'staff_directory.import_csv').kind === 'none') return 'none'
  return viewer.actor.role === 'SA' ? undefined : eq(importBatch.createdBy, viewer.userId)
}

export function blockedFor(policy: ImportPolicy, b: { newRows: number; duplicateRows: number; invalidRows: number }): ImportBatchView['blocked'] | undefined {
  const rejected = b.duplicateRows + b.invalidRows
  if (policy === 'all_or_nothing' && rejected > 0) {
    return {
      why: `${rejected} row${rejected === 1 ? ' is' : 's are'} duplicate or invalid, and the import policy is all-or-nothing, so nothing can be saved`,
      owner: 'Accommodation Admin who uploaded the file',
      next: 'Download the rejected rows, fix them in the file and upload it again. (A Super Admin can switch the policy to "save valid rows" in configuration)',
    }
  }
  if (b.newRows === 0) {
    return { why: 'No row in this file can be imported', owner: 'Accommodation Admin who uploaded the file', next: 'Download the rejected rows to see why, fix the file and upload it again' }
  }
  return undefined
}

export async function getImportBatch(db: Reader, viewer: Viewer, id: string): Promise<ImportBatchView | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null
  const vis = batchVisibility(viewer)
  if (vis === 'none') return null
  const [b] = await db.select().from(importBatch).where(and(eq(importBatch.id, id), vis)).limit(1)
  if (!b) return null
  const rows = await db.select({
    rowNo: importRow.rowNo, classification: importRow.classification, outcome: importRow.outcome, outcomeReason: importRow.outcomeReason,
    reasons: importRow.reasons, warnings: importRow.warnings,
    employeeId: sql<string>`coalesce(${importRow.raw}->>'employee_id', '')`,
    fullName: sql<string>`coalesce(${importRow.raw}->>'full_name', '')`,
    department: sql<string>`coalesce(${importRow.raw}->>'department', '')`,
  }).from(importRow).where(eq(importRow.batchId, b.id)).orderBy(asc(importRow.rowNo))

  const policy = b.policy ?? await importPolicy(db)
  const confirmed = b.status === 'confirmed'
  return {
    id: b.id, status: b.status, fileName: b.fileName, createdAt: b.createdAt, confirmedAt: b.confirmedAt, policy,
    summary: {
      total: b.totalRows, new: b.newRows, duplicate: b.duplicateRows, invalid: b.invalidRows, withWarnings: b.warningRows,
      created: b.createdCount, rejected: b.rejectedCount,
    },
    ignoredColumns: b.ignoredColumns,
    rows: rows.map(r => ({
      rowNo: r.rowNo, classification: r.classification, outcome: r.outcome,
      reasons: r.outcome === 'rejected' && r.outcomeReason ? [r.outcomeReason] : r.reasons,
      warnings: r.warnings, employeeId: r.employeeId, fullName: r.fullName, department: r.department,
    })),
    canConfirm: !confirmed && !blockedFor(policy, b),
    blocked: confirmed ? undefined : blockedFor(policy, b),
  }
}

/** The partial-import policy in force now (registry key import.partial_policy; AT-005 "approved partial-import policy"). */
export async function importPolicy(db: Reader): Promise<ImportPolicy> {
  return (await getConfig(db, 'import.partial_policy')) === 'all_or_nothing' ? 'all_or_nothing' : 'save_valid'
}

export interface RejectedRow { rowNo: number; reason: string; raw: Record<string, string> }

/** The rows of a batch that were or will be rejected, with the reason for each, in file order. Same visibility as the batch. */
export async function getRejectedRows(db: Reader, viewer: Viewer, id: string): Promise<{ batchId: string; rows: RejectedRow[] } | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null
  const vis = batchVisibility(viewer)
  if (vis === 'none') return null
  const [b] = await db.select({ id: importBatch.id }).from(importBatch).where(and(eq(importBatch.id, id), vis)).limit(1)
  if (!b) return null
  const rows = await db.select({
    rowNo: importRow.rowNo, classification: importRow.classification, outcome: importRow.outcome,
    outcomeReason: importRow.outcomeReason, reasons: importRow.reasons, raw: importRow.raw,
  }).from(importRow).where(and(
    eq(importRow.batchId, b.id),
    or(eq(importRow.outcome, 'rejected'), and(sql`${importRow.outcome} is null`, sql`${importRow.classification} <> 'new'`)),
  )).orderBy(asc(importRow.rowNo))
  return { batchId: b.id, rows: rows.map(r => ({ rowNo: r.rowNo, reason: r.outcomeReason ?? r.reasons.join('; '), raw: r.raw })) }
}
