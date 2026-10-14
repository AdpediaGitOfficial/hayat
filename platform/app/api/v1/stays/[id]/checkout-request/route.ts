import { route } from '@/server/http'
import { fail } from '@/server/command/result'
import { requestCheckout, requestInput } from '@/server/commands/stays/checkout'
import { idParam } from '@/server/queries/property/respond'

export const dynamic = 'force-dynamic'

/** The resident asks to leave on a date (voluntary checkout, D-63). Reception processes it; no approval. */
export const POST = route({
  name: 'stays.checkout.request',
  access: { kind: 'action', action: 'reservations_stays.request_checkout' },
  body: requestInput.omit({ stayId: true }),
  handler: (rc, body, _req, _r, { params }) => {
    const id = idParam(params)
    return id ? requestCheckout(rc, { ...body, stayId: id }) : Promise.resolve(fail.notFound())
  },
})
