import { route } from '@/server/http'
import { fail } from '@/server/command/result'
import { markLost, lostInput } from '@/server/commands/keys/movements'
import { idParam } from '@/server/queries/property/respond'

export const dynamic = 'force-dynamic'

/** Records the item as lost: note mandatory. The holder keeps it on their record until it is found, replaced or retired. */
export const POST = route({
  name: 'keys.lost',
  access: { kind: 'authenticated' },
  body: lostInput.omit({ itemId: true }),
  handler: (rc, body, _req, _r, { params }) => {
    const id = idParam(params)
    return id ? markLost(rc, { ...body, itemId: id }) : Promise.resolve(fail.notFound())
  },
})
