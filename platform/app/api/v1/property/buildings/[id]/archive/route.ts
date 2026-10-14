import { route } from '@/server/http'
import { fail } from '@/server/command/result'
import { archiveBuilding, input as archiveInput } from '@/server/commands/property/archiveBuilding'
import { previewArchive } from '@/server/queries/property/archivePreview'
import { idParam } from '@/server/queries/property/respond'

export const dynamic = 'force-dynamic'

/** What would stop this building being archived (AT-029). Read-only. ?cascade=1 treats active rooms and beds as "archived together". */
export const GET = route({
  name: 'property.building.archive_check',
  access: { kind: 'action', action: 'sites_buildings.manage' },
  handler: async (rc, _b, req, _r, { params }) => {
    const id = idParam(params)
    return id ? previewArchive(rc.actor, 'building', id, new URL(req.url).searchParams.get('cascade') === '1') : fail.notFound()
  },
})

/** Archive only, never delete. Refused with the dependencies listed while anything is occupied, reserved or still active. */
export const POST = route({
  name: 'property.building.archive',
  access: { kind: 'action', action: 'sites_buildings.manage' },
  body: archiveInput.omit({ id: true }),
  handler: (rc, body, _req, _r, { params }) => {
    const id = idParam(params)
    return id ? archiveBuilding(rc, { ...body, id }) : Promise.resolve(fail.notFound())
  },
})
