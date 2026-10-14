import { route } from '@/server/http'
import { ok } from '@/server/command/result'
import { createSite, input as createInput } from '@/server/commands/property/createSite'
import { listSites } from '@/server/queries/property/sites'

export const dynamic = 'force-dynamic'

export const GET = route({
  name: 'property.site.list',
  access: { kind: 'action', action: 'sites_buildings.view' },
  handler: async (rc, _b, req) => ok(await listSites(rc.actor, { includeArchived: new URL(req.url).searchParams.get('archived') === '1' })),
})

export const POST = route({
  name: 'property.site.create',
  access: { kind: 'action', action: 'sites_buildings.create_site' },
  body: createInput,
  handler: (rc, body) => createSite(rc, body),
})
