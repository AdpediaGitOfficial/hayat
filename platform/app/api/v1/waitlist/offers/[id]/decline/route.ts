import { route } from '@/server/http'
import { fail } from '@/server/command/result'
import { declineOffer, declineInput } from '@/server/commands/waitlist/respond'
import { idParam } from '@/server/queries/property/respond'

export const dynamic = 'force-dynamic'

/** The offered resident declines. The first decline keeps their place; the second moves them to the back of the queue. */
export const POST = route({
  name: 'waitlist.offer.decline',
  access: { kind: 'action', action: 'requests_waitlist.respond_offer' },
  body: declineInput.omit({ offerId: true }),
  handler: (rc, body, _req, _r, { params }) => {
    const offerId = idParam(params)
    return offerId ? declineOffer(rc, { ...body, offerId }) : Promise.resolve(fail.notFound())
  },
})
