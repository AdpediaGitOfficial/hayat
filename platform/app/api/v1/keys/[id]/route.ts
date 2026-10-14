import { route } from '@/server/http'
import { fail } from '@/server/command/result'
import { updateInput, updateItem } from '@/server/commands/keys/registry'
import { found, idParam } from '@/server/queries/property/respond'
import { getItemDetail } from '@/server/queries/keys/items'

export const dynamic = 'force-dynamic'

/** One item with its history. Out of scope reads exactly like an item that does not exist. */
export const GET = route({
  name: 'keys.detail',
  access: { kind: 'authenticated' },
  handler: async (rc, _b, _req, _r, { params }) => {
    const id = idParam(params)
    return id ? found(await getItemDetail(rc.actor, id)) : fail.notFound()
  },
})

/** The note, and the room or bed an item belongs to. */
export const PATCH = route({
  name: 'keys.update',
  method: 'PATCH',
  access: { kind: 'action', action: 'keys.manage' },
  body: updateInput.omit({ id: true }),
  handler: (rc, body, _req, _r, { params }) => {
    const id = idParam(params)
    return id ? updateItem(rc, { ...body, id }) : Promise.resolve(fail.notFound())
  },
})
