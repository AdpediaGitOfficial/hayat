import { route } from '@/server/http'
import { fail } from '@/server/command/result'
import { retireItem, retireInput } from '@/server/commands/keys/movements'
import { idParam } from '@/server/queries/property/respond'

export const dynamic = 'force-dynamic'

/** Takes the item out of use for good, with a reason (Accommodation Admin, Super Admin). */
export const POST = route({
  name: 'keys.retire',
  access: { kind: 'action', action: 'keys.manage' },
  body: retireInput.omit({ itemId: true }),
  handler: (rc, body, _req, _r, { params }) => {
    const id = idParam(params)
    return id ? retireItem(rc, { ...body, itemId: id }) : Promise.resolve(fail.notFound())
  },
})
