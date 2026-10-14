import { z } from 'zod'
import { site } from '@/server/db/schema'
import { audit } from '@/server/audit'
import { authorize } from '@/server/command/authorize'
import { runCommand } from '@/server/command/run'
import type { RequestContext } from '@/server/command/context'
import { ok, type Result } from '@/server/command/result'
import { codeSchema, duplicate, nameSchema, SITE_KINDS, snap, timeZoneSchema } from './shared'

export const input = z.object({
  code: codeSchema,
  name: nameSchema,
  kind: z.enum(SITE_KINDS).default('other'),
  /** G-01 is open: UTC until the administrator sets the site's own zone. */
  timeZone: timeZoneSchema.default('UTC'),
})
export type CreateSiteInput = z.infer<typeof input>
export interface CreateSiteOut { id: string; code: string; name: string }

/** Only a Super Admin creates sites (D-13). */
export function createSite(rc: RequestContext, i: CreateSiteInput): Promise<Result<CreateSiteOut>> {
  return runCommand(rc, async c => {
    const denied = authorize(c, 'sites_buildings.create_site')
    if (denied) return denied
    const [row] = await c.tx.insert(site).values({ code: i.code, name: i.name, kind: i.kind, timeZone: i.timeZone }).onConflictDoNothing().returning()
    if (!row) return duplicate('code', `A site with code "${i.code}" already exists (it may be archived)`, 'Choose a different code, or open the existing site')
    await audit(c, { action: 'property.site.created', entityType: 'site', entityId: row.id, siteId: row.id, after: snap.site(row) })
    return ok({ id: row.id, code: row.code, name: row.name }, `Site ${row.name} created`)
  })
}
