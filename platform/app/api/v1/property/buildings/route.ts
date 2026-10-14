import { route } from '@/server/http'
import { createBuilding, input as createInput } from '@/server/commands/property/createBuilding'

export const dynamic = 'force-dynamic'

/** Super Admin, or an Accommodation Admin holding Building Creation inside their own sites. */
export const POST = route({
  name: 'property.building.create',
  access: { kind: 'action', action: 'sites_buildings.create_building' },
  body: createInput,
  handler: (rc, body) => createBuilding(rc, body),
})
