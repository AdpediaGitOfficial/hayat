import { route } from '@/server/http'
import { fail } from '@/server/command/result'
import { updateSite, input as updateInput } from '@/server/commands/property/updateSite'
import { getSiteTree } from '@/server/queries/property/tree'
import { found, idParam } from '@/server/queries/property/respond'
import { BED_STATES } from '@/domain/enums'

export const dynamic = 'force-dynamic'

/** The building -> room -> bed tree of one site. Query: ?state=blocked&reserved=1&q=text&archived=1 */
export const GET = route({
  name: 'property.site.tree',
  access: { kind: 'action', action: 'rooms_beds.view' },
  handler: async (rc, _b, req, _r, { params }) => {
    const id = idParam(params)
    if (!id) return fail.notFound()
    const sp = new URL(req.url).searchParams
    const state = sp.get('state')
    const tree = await getSiteTree(rc.actor, id, {
      state: state && (BED_STATES as readonly string[]).includes(state) ? (state as (typeof BED_STATES)[number]) : undefined,
      reserved: sp.get('reserved') === '1',
      q: sp.get('q') ?? undefined,
      includeArchived: sp.get('archived') === '1',
    })
    return found(tree)
  },
})

export const PATCH = route({
  name: 'property.site.update',
  method: 'PATCH',
  access: { kind: 'action', action: 'sites_buildings.manage' },
  body: updateInput.omit({ id: true }),
  handler: (rc, body, _req, _r, { params }) => {
    const id = idParam(params)
    return id ? updateSite(rc, { ...body, id }) : Promise.resolve(fail.notFound())
  },
})
