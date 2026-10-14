import { z } from 'zod'
import { runCommand } from '@/server/command/run'
import { fail, ok, type Result } from '@/server/command/result'
import type { RequestContext } from '@/server/command/context'
import { audit } from '@/server/audit'
import { getRejectedRows } from '@/server/queries/staff/imports'
import { serializeCsv } from './csv'
import { requireDirectory } from './guard'

export const input = z.object({ batchId: z.string() })
export type RejectedInput = z.infer<typeof input>

/** Columns of the rejected-rows file: the row number and the reason, then the template columns so the file can be fixed and uploaded again. */
const COLUMNS = ['employee_id', 'full_name', 'gender', 'department', 'grade', 'phone', 'email', 'joining_date', 'employment_status', 'emergency_contact_name', 'emergency_contact_phone'] as const

/**
 * The rejected rows of a batch as a CSV download (AT-005). It is an export of personal data, so it needs the import action,
 * is limited to the person who uploaded the file (or a Super Admin), is written to the audit log, and goes through the one
 * formula-injection guard like every CSV we emit.
 */
export async function exportRejectedRows(rc: RequestContext, raw: RejectedInput): Promise<Result<{ filename: string; csv: string; rows: number }>> {
  return runCommand(rc, async c => {
    const denied = requireDirectory(c, 'staff_directory.import_csv')
    if (denied) return denied
    const found = await getRejectedRows(c.tx, { actor: c.actor, userId: c.user.id }, raw.batchId)
    if (!found) return fail.notFound()
    const extra = found.rows.some(r => r.raw.emergency_contact) ? (['emergency_contact'] as const) : ([] as const)
    const cols = [...COLUMNS, ...extra]
    const csv = serializeCsv([
      ['row', 'reason', ...cols],
      ...found.rows.map(r => [r.rowNo, r.reason, ...cols.map(k => r.raw[k] ?? '')]),
    ])
    await audit(c, { action: 'staff.import.rejected_exported', entityType: 'import_batch', entityId: found.batchId, after: { rows: found.rows.length } })
    return ok({ filename: `rejected-rows-${found.batchId.slice(0, 8)}.csv`, csv, rows: found.rows.length })
  })
}
