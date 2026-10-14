import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { runCommand } from '@/server/command/run'
import { fail, ok, type Result } from '@/server/command/result'
import type { RequestContext } from '@/server/command/context'
import { notSelf } from '@/server/command/authorize'
import { audit } from '@/server/audit'
import { staffProfile } from '@/server/db/schema'
import { fullRecord } from '@/server/queries/staff/list'
import type { StaffFull } from '@/server/queries/staff/shapes'
import { validateStaff, type FieldName, type StaffValues } from './fields'
import { isUuid, requireDirectory } from './guard'
import { auditValues } from './auditing'
import { staffFieldsSchema } from './create'

/**
 * A patch: only the fields present are changed; null or an empty string clears an optional field.
 * The employee ID is not editable in Stage 1: it is the business key (D-05) and other records will point at it.
 */
export const input = z.object({ id: z.string().uuid(), ...staffFieldsSchema })
export type UpdateStaffInput = z.infer<typeof input>

const EDITABLE: readonly Exclude<FieldName, 'employeeId'>[] = ['fullName', 'gender', 'department', 'grade', 'phone', 'email', 'emergencyContact', 'joiningDate']

export async function updateStaff(rc: RequestContext, raw: UpdateStaffInput): Promise<Result<StaffFull>> {
  return runCommand(rc, async c => {
    const denied = requireDirectory(c, 'staff_directory.manage')
    if (denied) return denied
    if (!isUuid(raw.id)) return fail.notFound()
    const given = EDITABLE.filter(f => raw[f] !== undefined)
    const { values, errors } = validateStaff(raw, given)
    if (Object.keys(errors).length) return fail.invalid('Some fields need attention', errors)

    const [cur] = await c.tx.select().from(staffProfile).where(eq(staffProfile.id, raw.id)).for('update')
    if (!cur) return fail.notFound()
    const self = notSelf(c, cur.id, 'change staff details')
    if (self) return self
    if (cur.archivedAt) return fail.conflict('This profile is archived and cannot be edited', 'Super Admin', 'Ask a Super Admin whether it should be reinstated')

    const before: Partial<StaffValues> = {}
    const after: Partial<StaffValues> = {}
    for (const f of given) {
      const next = (values as Record<string, unknown>)[f]
      if ((cur as Record<string, unknown>)[f] !== next) {
        ;(before as Record<string, unknown>)[f] = (cur as Record<string, unknown>)[f]
        ;(after as Record<string, unknown>)[f] = next
      }
    }
    if (Object.keys(after).length === 0) return ok((await fullRecord(c.tx, cur.id))!, 'Nothing to change')

    await c.tx.update(staffProfile).set({ ...after, updatedAt: c.now }).where(eq(staffProfile.id, cur.id))
    await audit(c, { action: 'staff.updated', entityType: 'staff_profile', entityId: cur.id, before: auditValues(before), after: auditValues(after) })
    return ok((await fullRecord(c.tx, cur.id))!, 'Saved')
  })
}
