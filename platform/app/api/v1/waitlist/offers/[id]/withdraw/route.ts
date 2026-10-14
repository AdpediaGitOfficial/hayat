import { route } from '@/server/http'
import { fail } from '@/server/command/result'
import { withdrawOffer, withdrawInput } from '@/server/commands/waitlist/offer'
import { idParam } from '@/server/queries/property/respond'

export const dynamic = 'force-dynamic'

/** Withdraw a bed offer (Accommodation Admin, reason mandatory). The hold is released and the person keeps their place. */
export const POST = route({
  name: 'waitlist.offer.withdraw',
  access: { kind: 'action', action: 'requests_waitlist.manage_offers' },
  body: withdrawInput.omit({ offerId: true }),
  handler: (rc, body, _req, _r, { params }) => {
    const offerId = idParam(params)
    return offerId ? withdrawOffer(rc, { ...body, offerId }) : Promise.resolve(fail.notFound())
  },
})
