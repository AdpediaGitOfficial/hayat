import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { runCommand } from '@/server/command/run'
import { fail, ok, type Failure, type Result } from '@/server/command/result'
import type { CommandContext, RequestContext } from '@/server/command/context'
import { audit } from '@/server/audit'
import { staffProfile } from '@/server/db/schema'
import { staffAccess } from '@/server/queries/staff/access'
import { fullRecord } from '@/server/queries/staff/list'
import type { StaffFull } from '@/server/queries/staff/shapes'
import { normaliseStaff } from './fields'
import { requireDirectory } from './guard'
import { auditValues } from './auditing'

const text = z.string().max(2000).nullish()
/** Loose on purpose: fields.ts owns every rule and answers with a message per field. */
export const staffFieldsSchema = {
  fullName: text,
  gender: text,
  department: text,
  grade: z.union([z.number(), z.string().max(10)]).nullish(),
  phone: text,
  email: text,
  emergencyContact: text,
  joiningDate: text,
}
export const input = z.object({ employeeId: z.string().max(2000), ...staffFieldsSchema })
export type CreateStaffInput = z.infer<typeof input>

/**
 * AT-003: a second profile for an existing employee ID is refused with a message that names the existing ID, and is never
 * merged. Only an actor who may view the directory also learns whose record it is.
 */
export async function duplicateFailure(c: Pick<CommandContext, 'tx' | 'actor'>, key: string): Promise<Failure> {
  const [ex] = await c.tx.select({ id: staffProfile.id, employeeId: staffProfile.employeeId, fullName: staffProfile.fullName, archivedAt: staffProfile.archivedAt, employmentStatus: staffProfile.employmentStatus, leftEffective: staffProfile.leftEffective, leftAt: staffProfile.leftAt })
    .from(staffProfile).where(sql`lower(btrim(${staffProfile.employeeId})) = ${key}`).limit(1)
  const mayView = staffAccess(c.actor)?.shape === 'full'
  if (!ex) return fail.conflict('That employee ID was just taken by another change', 'Accommodation Admin', 'Search for the employee ID and open the existing record')
  const who = mayView ? ` (${ex.fullName}${ex.archivedAt ? ', archived' : ''})` : ''
  // WP-H: a former employee who returns is rehired on the existing profile (D-41), never added a second time.
  const leftOn = ex.leftEffective ?? ex.leftAt?.toISOString().slice(0, 10)
  const rehire = ex.employmentStatus === 'left' && !ex.archivedAt ? `. This employee left on ${leftOn ?? 'an earlier date'}: use Rehire` : ''
  const f = fail.conflict(
    `Employee ID ${ex.employeeId} already exists${who}. A second profile is never created and records are never merged automatically${rehire}`,
    'Accommodation Admin',
    ex.archivedAt ? 'This profile is archived. Ask a Super Admin whether it should be reinstated; do not reuse the ID' : 'Open the existing record, or check the employee ID with HR',
    mayView ? { existingStaffId: ex.id } : undefined,
  )
  return { ...f, fields: { employeeId: 'Already in use' } }
}

export async function createStaff(rc: RequestContext, raw: CreateStaffInput): Promise<Result<StaffFull>> {
  return runCommand(rc, async c => {
    const denied = requireDirectory(c, 'staff_directory.manage')
    if (denied) return denied
    const n = normaliseStaff(raw)
    if (!n.ok) return fail.invalid('Some fields need attention', n.errors)
    const v = n.value
    const [row] = await c.tx.insert(staffProfile).values({ ...v, source: 'manual' }).onConflictDoNothing().returning({ id: staffProfile.id })
    // Another create (or import) got the same employee ID first: ON CONFLICT waited for it and skipped our insert. Exactly one wins.
    if (!row) return duplicateFailure(c, v.employeeId.toLowerCase())
    await audit(c, { action: 'staff.created', entityType: 'staff_profile', entityId: row.id, after: { ...auditValues(v), source: 'manual' } })
    return ok((await fullRecord(c.tx, row.id))!, `Added ${v.fullName}`)
  })
}
