import { route } from '@/server/http'
import { fail } from '@/server/command/result'
import { requestExtension, input } from '@/server/commands/stays/extension'
import { idParam } from '@/server/queries/property/respond'

export const dynamic = 'force-dynamic'

/** The resident (own stay) or an Accommodation Admin asks for a later departure day. Beyond policy needs a reason. */
export const POST = route({
  name: 'stays.extension.request',
  access: { kind: 'action', action: 'reservations_stays.view' },
  body: input.omit({ stayId: true }),
  handler: (rc, body, _req, _r, { params }) => {
    const id = idParam(params)
    return id ? requestExtension(rc, { ...body, stayId: id }) : Promise.resolve(fail.notFound())
  },
})
