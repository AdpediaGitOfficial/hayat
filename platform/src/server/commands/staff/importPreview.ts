import { z } from 'zod'
import { inArray, sql } from 'drizzle-orm'
import { runCommand } from '@/server/command/run'
import { fail, ok, type Result } from '@/server/command/result'
import type { RequestContext } from '@/server/command/context'
import { audit } from '@/server/audit'
import { staffProfile } from '@/server/db/schema'
import { importBatch, importRow } from '@/server/db/schema.staff'
import { getImportBatch, importPolicy, type ImportBatchView } from '@/server/queries/staff/imports'
import { requireDirectory } from './guard'
import { analyseRows, classifyRows, keysOf, MAX_FILE_CHARS, readStaffCsv } from './importRules'

/**
 * Step 1 of the import (AT-004). The file is read, every row is checked and classified, and the result is stored as a batch
 * so the person can look at it and then confirm. Nothing is written to staff_profile here.
 * Limits: the file may be at most 2 000 000 characters and 5 000 staff rows.
 */
export const input = z.object({
  csv: z.string().max(MAX_FILE_CHARS, 'The file is larger than 2 MB. Split it into smaller files'),
  fileName: z.string().trim().max(200).optional(),
})
export type PreviewInput = z.infer<typeof input>

const CHUNK = 400

export async function previewStaffImport(rc: RequestContext, raw: PreviewInput): Promise<Result<ImportBatchView>> {
  return runCommand(rc, async c => {
    const denied = requireDirectory(c, 'staff_directory.import_csv')
    if (denied) return denied

    const read = readStaffCsv(raw.csv)
    if (!read.ok) return { ...fail.invalid(read.reason, { csv: read.reason }), next: read.next }

    const drafts = analyseRows(read.rows, read.headerCount)
    const keys = keysOf(drafts)
    const existing = new Set<string>()
    for (let i = 0; i < keys.length; i += 2000) {
      const found = await c.tx.select({ k: sql<string>`lower(btrim(${staffProfile.employeeId}))` }).from(staffProfile)
        .where(inArray(sql`lower(btrim(${staffProfile.employeeId}))`, keys.slice(i, i + 2000)))
      for (const f of found) existing.add(f.k)
    }
    const rows = classifyRows(drafts, existing)
    const count = (k: string) => rows.filter(r => r.classification === k).length
    const counts = { total: rows.length, new: count('new'), duplicate: count('duplicate'), invalid: count('invalid'), withWarnings: rows.filter(r => r.classification === 'new' && r.warnings.length > 0).length }

    const [batch] = await c.tx.insert(importBatch).values({
      fileName: raw.fileName || null, createdBy: c.user.id,
      totalRows: counts.total, newRows: counts.new, duplicateRows: counts.duplicate, invalidRows: counts.invalid, warningRows: counts.withWarnings,
      ignoredColumns: read.ignoredColumns,
    }).returning({ id: importBatch.id })

    for (let i = 0; i < rows.length; i += CHUNK) {
      await c.tx.insert(importRow).values(rows.slice(i, i + CHUNK).map(r => ({
        batchId: batch.id, rowNo: r.rowNo, raw: r.raw, data: r.values ? { ...r.values } : null, employeeKey: r.key,
        classification: r.classification, reasons: r.reasons, warnings: r.warnings,
      })))
    }

    await audit(c, {
      action: 'staff.import.previewed', entityType: 'import_batch', entityId: batch.id,
      after: { ...counts, blankLinesSkipped: read.blankSkipped, fileName: raw.fileName || null, policy: await importPolicy(c.tx) },
    })
    const view = await getImportBatch(c.tx, { actor: c.actor, userId: c.user.id }, batch.id)
    return ok(view!, 'Preview ready. Nothing has been saved yet')
  })
}
