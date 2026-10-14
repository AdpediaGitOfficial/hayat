import { route } from '@/server/http'
import { fail } from '@/server/command/result'
import { updateRoom, input as updateInput } from '@/server/commands/property/updateRoom'
import { getRoomDetail } from '@/server/queries/property/detail'
import { found, idParam } from '@/server/queries/property/respond'

export const dynamic = 'force-dynamic'

export const GET = route({
  name: 'property.room.get',
  access: { kind: 'action', action: 'rooms_beds.view' },
  handler: async (rc, _b, _req, _r, { params }) => {
    const id = idParam(params)
    return id ? found(await getRoomDetail(rc.actor, id)) : fail.notFound()
  },
})

export const PATCH = route({
  name: 'property.room.update',
  method: 'PATCH',
  access: { kind: 'action', action: 'rooms_beds.manage' },
  body: updateInput.omit({ id: true }),
  handler: (rc, body, _req, _r, { params }) => {
    const id = idParam(params)
    return id ? updateRoom(rc, { ...body, id }) : Promise.resolve(fail.notFound())
  },
})
