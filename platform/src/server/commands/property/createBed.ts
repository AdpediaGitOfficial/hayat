import { z } from 'zod'
import { bed } from '@/server/db/schema'
import { audit } from '@/server/audit'
import { authorize } from '@/server/command/authorize'
import { runCommand } from '@/server/command/run'
import type { RequestContext } from '@/server/command/context'
import { fail, failure, ok, type Result } from '@/server/command/result'
import { codeSchema, duplicate, idSchema, loadBuilding, loadRoom, snap } from './shared'

export const input = z.object({ roomId: idSchema, code: codeSchema })
export type CreateBedInput = z.infer<typeof input>

/** Adds one bed to a room. It starts Available (the database default); readiness gates check-in, not creation. */
export function createBed(rc: RequestContext, i: CreateBedInput): Promise<Result<{ id: string; code: string }>> {
  return runCommand(rc, async c => {
    // FOR SHARE on the room: archiving the room takes FOR UPDATE, so the bed is either seen by that archive or refused here.
    const r = await loadRoom(c.tx, i.roomId, 'share')
    if (!r) return fail.notFound()
    const denied = authorize(c, 'rooms_beds.manage', { siteId: r.siteId })
    if (denied) return denied
    if (r.archivedAt) return failure('conflict', `Room ${r.name} is archived`, { owner: 'Accommodation Admin', next: 'Add the bed to an active room' })
    if (r.buildingId) {
      const b = await loadBuilding(c.tx, r.buildingId)
      if (b?.archivedAt) return failure('conflict', `Building ${b.name} is archived`, { owner: 'Super Admin', next: 'Add the bed to a room in an active building' })
    }
    const [row] = await c.tx.insert(bed).values({ siteId: r.siteId, roomId: r.id, code: i.code }).onConflictDoNothing().returning()
    if (!row) return duplicate('code', `Bed code "${i.code}" is already used in this site (it may be archived)`, 'Use a different code. Bed codes are unique within a site')
    await audit(c, { action: 'property.bed.created', entityType: 'bed', entityId: row.id, siteId: r.siteId, after: snap.bed(row) })
    return ok({ id: row.id, code: row.code }, `Bed ${row.code} added to room ${r.name}`)
  })
}
