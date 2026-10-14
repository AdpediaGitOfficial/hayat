import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { site } from '@/server/db/schema'
import { audit } from '@/server/audit'
import { authorize } from '@/server/command/authorize'
import { runCommand } from '@/server/command/run'
import type { RequestContext } from '@/server/command/context'
import { fail, ok, type Result } from '@/server/command/result'
import { idSchema, loadSite, nameSchema, SITE_KINDS, snap, timeZoneSchema } from './shared'

export const input = z.object({
  id: idSchema,
  name: nameSchema.optional(),
  kind: z.enum(SITE_KINDS).optional(),
  timeZone: timeZoneSchema.optional(),
})
export type UpdateSiteInput = z.infer<typeof input>

/** Name, kind and time zone. The code is a business key and is not editable. Super Admin only. */
export function updateSite(rc: RequestContext, i: UpdateSiteInput): Promise<Result<{ id: string }>> {
  return runCommand(rc, async c => {
    const denied = authorize(c, 'sites_buildings.manage', { siteId: i.id })
    if (denied) return denied
    const before = await loadSite(c.tx, i.id, 'update')
    if (!before) return fail.notFound()
    if (i.name === undefined && i.kind === undefined && i.timeZone === undefined) return fail.invalid('Nothing to change', { name: 'Change at least one field' })
    const [after] = await c.tx.update(site).set({
      name: i.name ?? before.name, kind: i.kind ?? before.kind, timeZone: i.timeZone ?? before.timeZone,
    }).where(eq(site.id, i.id)).returning()
    await audit(c, { action: 'property.site.updated', entityType: 'site', entityId: i.id, siteId: i.id, before: snap.site(before), after: snap.site(after) })
    return ok({ id: i.id }, `Site ${after.name} updated`)
  })
}
