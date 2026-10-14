import { route } from '@/server/http'
import { fail } from '@/server/command/result'
import { acknowledgeCheckout, ackInput } from '@/server/commands/stays/checkout'
import { idParam } from '@/server/queries/property/respond'

export const dynamic = 'force-dynamic'

/** Reception acknowledges a voluntary checkout request (within 1 business day). */
export const POST = route({
  name: 'stays.checkout.acknowledge',
  access: { kind: 'action', action: 'checkin_checkout.execute' },
  body: ackInput.omit({ id: true }),
  handler: (rc, body, _req, _r, { params }) => {
    const id = idParam(params)
    return id ? acknowledgeCheckout(rc, { ...body, id: id }) : Promise.resolve(fail.notFound())
  },
})
