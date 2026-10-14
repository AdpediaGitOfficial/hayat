import { route } from '@/server/http'
import { fail } from '@/server/command/result'
import { foundItem, foundInput } from '@/server/commands/keys/movements'
import { idParam } from '@/server/queries/property/respond'

export const dynamic = 'force-dynamic'

/** A lost item turned up. */
export const POST = route({
  name: 'keys.found',
  access: { kind: 'authenticated' },
  body: foundInput.omit({ itemId: true }),
  handler: (rc, body, _req, _r, { params }) => {
    const id = idParam(params)
    return id ? foundItem(rc, { ...body, itemId: id }) : Promise.resolve(fail.notFound())
  },
})
