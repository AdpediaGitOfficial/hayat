import { route } from '@/server/http'
import { fail } from '@/server/command/result'
import { processCheckout, processInput } from '@/server/commands/stays/checkout'
import { idParam } from '@/server/queries/property/respond'

export const dynamic = 'force-dynamic'

/** Reception checks the resident out: stay closed, claim released, bed to Needs cleaning. Not clearance, not bed ready (D-64). */
export const POST = route({
  name: 'stays.checkout.process',
  access: { kind: 'action', action: 'checkin_checkout.execute' },
  body: processInput.omit({ stayId: true }),
  handler: (rc, body, _req, _r, { params }) => {
    const id = idParam(params)
    return id ? processCheckout(rc, { ...body, stayId: id }) : Promise.resolve(fail.notFound())
  },
})
