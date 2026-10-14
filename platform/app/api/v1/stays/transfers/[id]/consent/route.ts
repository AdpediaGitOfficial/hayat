import { route } from '@/server/http'
import { fail } from '@/server/command/result'
import { recordSwapConsent, consentInput } from '@/server/commands/stays/decideTransfer'
import { idParam } from '@/server/queries/property/respond'

export const dynamic = 'force-dynamic'

/** A swap occupant confirms, or an Accommodation Admin records how they agreed. */
export const POST = route({
  name: 'stays.swap.consent',
  access: { kind: 'action', action: 'transfers_swaps.view' },
  body: consentInput.omit({ id: true }),
  handler: (rc, body, _req, _r, { params }) => {
    const id = idParam(params)
    return id ? recordSwapConsent(rc, { ...body, id: id }) : Promise.resolve(fail.notFound())
  },
})
