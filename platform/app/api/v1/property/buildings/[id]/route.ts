import { route } from '@/server/http'
import { fail } from '@/server/command/result'
import { updateBuilding, input as updateInput } from '@/server/commands/property/updateBuilding'
import { getBuildingDetail } from '@/server/queries/property/detail'
import { found, idParam } from '@/server/queries/property/respond'

export const dynamic = 'force-dynamic'

export const GET = route({
  name: 'property.building.get',
  access: { kind: 'action', action: 'rooms_beds.view' },
  handler: async (rc, _b, _req, _r, { params }) => {
    const id = idParam(params)
    return id ? found(await getBuildingDetail(rc.actor, id)) : fail.notFound()
  },
})

export const PATCH = route({
  name: 'property.building.update',
  method: 'PATCH',
  access: { kind: 'action', action: 'sites_buildings.manage' },
  body: updateInput.omit({ id: true }),
  handler: (rc, body, _req, _r, { params }) => {
    const id = idParam(params)
    return id ? updateBuilding(rc, { ...body, id }) : Promise.resolve(fail.notFound())
  },
})
