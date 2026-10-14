import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { room } from '@/server/db/schema'
import { audit } from '@/server/audit'
import { authorize } from '@/server/command/authorize'
import { runCommand } from '@/server/command/run'
import type { RequestContext } from '@/server/command/context'
import { fail, failure, ok, type Result } from '@/server/command/result'
import { findBlockers, loadStructure, DEPENDENCY_CHECKERS } from './dependencies'
import { duplicate, GENDER_POLICIES, guardUnique, idSchema, loadRoom, nameSchema, clearableText, snap } from './shared'

export const input = z.object({
  id: idSchema,
  name: nameSchema.optional(),
  /** Pass null (or empty) to clear. Leave out to keep. */
  floor: clearableText(40),
  unit: clearableText(40),
  genderPolicy: z.enum(GENDER_POLICIES).optional(),
})
export type UpdateRoomInput = z.infer<typeof input>

/**
 * Name, floor, unit and gender policy. The gender policy is an eligibility rule (AT-006): it cannot change while
 * residents or bookings are in the room, because the rule would then contradict people already placed.
 */
export function updateRoom(rc: RequestContext, i: UpdateRoomInput): Promise<Result<{ id: string }>> {
  return runCommand(rc, async c => {
    const found = await loadRoom(c.tx, i.id)
    if (!found) return fail.notFound()
    const denied = authorize(c, 'rooms_beds.manage', { siteId: found.siteId })
    if (denied) return denied
    const before = await loadRoom(c.tx, i.id, 'update')
    if (!before) return fail.notFound()
    if (before.archivedAt) return failure('conflict', `Room ${before.name} is archived`, { owner: 'Accommodation Admin', next: 'Archived rooms cannot be edited' })
    if (i.name === undefined && i.floor === undefined && i.unit === undefined && i.genderPolicy === undefined) {
      return fail.invalid('Nothing to change', { name: 'Change at least one field' })
    }

    if (i.genderPolicy !== undefined && i.genderPolicy !== before.genderPolicy) {
      const scope = await loadStructure(c.tx, 'room', before.id, { lock: true, cascade: false })
      // Only the people-related checkers matter here: who is in the room, and who is booked into it.
      const report = await findBlockers(c.tx, scope!, DEPENDENCY_CHECKERS.filter(f => f.people))
      if (report.total > 0) {
        return fail.conflict(
          `Room ${before.name} has residents or bookings, so its gender policy can't change`, 'Accommodation Admin',
          'Move or cancel them first, or leave the policy as it is', { blockers: report.blockers, total: report.total, truncated: report.truncated })
      }
    }

    const after = await guardUnique(c.tx, q => q.update(room).set({
      name: i.name ?? before.name,
      floor: i.floor === undefined ? before.floor : (i.floor || null),
      unit: i.unit === undefined ? before.unit : (i.unit || null),
      genderPolicy: i.genderPolicy ?? before.genderPolicy,
    }).where(eq(room.id, i.id)).returning())
    if (!after) return duplicate('name', 'There is already a room with that name in that building, floor and unit', 'Use a different name')
    await audit(c, { action: 'property.room.updated', entityType: 'room', entityId: i.id, siteId: before.siteId, before: snap.room(before), after: snap.room(after[0]) })
    return ok({ id: i.id }, `Room ${after[0].name} updated`)
  })
}
