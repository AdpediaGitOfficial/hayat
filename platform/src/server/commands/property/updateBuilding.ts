import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { building } from '@/server/db/schema'
import { audit } from '@/server/audit'
import { authorize } from '@/server/command/authorize'
import { runCommand } from '@/server/command/run'
import type { RequestContext } from '@/server/command/context'
import { fail, failure, ok, type Result } from '@/server/command/result'
import { codeSchema, duplicate, guardUnique, idSchema, loadBuilding, nameSchema, snap } from './shared'

export const input = z.object({ id: idSchema, code: codeSchema.optional(), name: nameSchema.optional() })
export type UpdateBuildingInput = z.infer<typeof input>

/** Rename a building or change its code. Super Admin only (matrix: "Sites & buildings: manage"). */
export function updateBuilding(rc: RequestContext, i: UpdateBuildingInput): Promise<Result<{ id: string }>> {
  return runCommand(rc, async c => {
    // Resolve the site first, so an out-of-scope building looks exactly like a missing one (AT-002).
    const found = await loadBuilding(c.tx, i.id)
    if (!found) return fail.notFound()
    const denied = authorize(c, 'sites_buildings.manage', { siteId: found.siteId })
    if (denied) return denied
    const before = await loadBuilding(c.tx, i.id, 'update')
    if (!before) return fail.notFound()
    if (before.archivedAt) return failure('conflict', `Building ${before.name} is archived`, { owner: 'Super Admin', next: 'Archived buildings cannot be edited' })
    if (i.code === undefined && i.name === undefined) return fail.invalid('Nothing to change', { name: 'Change at least one field' })
    const after = await guardUnique(c.tx, q => q.update(building).set({ code: i.code ?? before.code, name: i.name ?? before.name }).where(eq(building.id, i.id)).returning())
    if (!after) return duplicate('code', `That site already has a building with code "${i.code}"`, 'Choose a different code')
    await audit(c, { action: 'property.building.updated', entityType: 'building', entityId: i.id, siteId: before.siteId, before: snap.building(before), after: snap.building(after[0]) })
    return ok({ id: i.id }, `Building ${after[0].name} updated`)
  })
}
