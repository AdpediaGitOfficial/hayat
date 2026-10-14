import { z } from 'zod'
import { building } from '@/server/db/schema'
import { audit } from '@/server/audit'
import { authorize } from '@/server/command/authorize'
import { runCommand } from '@/server/command/run'
import type { RequestContext } from '@/server/command/context'
import { fail, failure, ok, type Result } from '@/server/command/result'
import { codeSchema, duplicate, idSchema, loadSite, nameSchema, snap } from './shared'

export const input = z.object({ siteId: idSchema, code: codeSchema, name: nameSchema })
export type CreateBuildingInput = z.infer<typeof input>

/**
 * Super Admin, or an Accommodation Admin holding the Building Creation capability inside their own sites (D-13, D-15).
 * The capability adds the action, never the scope (D-22): the site must be one of the actor's.
 */
export function createBuilding(rc: RequestContext, i: CreateBuildingInput): Promise<Result<{ id: string; code: string; name: string }>> {
  return runCommand(rc, async c => {
    const denied = authorize(c, 'sites_buildings.create_building', { siteId: i.siteId })
    if (denied) return denied
    const s = await loadSite(c.tx, i.siteId, 'share')
    if (!s) return fail.notFound()
    if (s.archivedAt) return failure('conflict', `Site ${s.name} is archived`, { owner: 'Super Admin', next: 'Choose an active site' })
    // Two admins creating the same code at once: the unique index makes the second wait, then insert nothing.
    const [row] = await c.tx.insert(building).values({ siteId: s.id, code: i.code, name: i.name }).onConflictDoNothing().returning()
    if (!row) return duplicate('code', `Site ${s.name} already has a building with code "${i.code}" (it may be archived)`, 'Choose a different code, or open the existing building')
    await audit(c, { action: 'property.building.created', entityType: 'building', entityId: row.id, siteId: s.id, after: snap.building(row) })
    return ok({ id: row.id, code: row.code, name: row.name }, `Building ${row.name} created`)
  })
}
