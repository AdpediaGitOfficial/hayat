import { route } from '@/server/http'
import { fail } from '@/server/command/result'
import { requestTransfer, input } from '@/server/commands/stays/requestTransfer'
import { idParam } from '@/server/queries/property/respond'

export const dynamic = 'force-dynamic'

/** The resident (own stay) or an Accommodation Admin asks to move to another bed; no destination means "any suitable". */
export const POST = route({
  name: 'stays.transfer.request',
  access: { kind: 'action', action: 'reservations_stays.view' },
  body: input.omit({ stayId: true }),
  handler: (rc, body, _req, _r, { params }) => {
    const id = idParam(params)
    return id ? requestTransfer(rc, { ...body, stayId: id }) : Promise.resolve(fail.notFound())
  },
})
