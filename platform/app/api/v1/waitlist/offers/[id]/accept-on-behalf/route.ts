import { route } from '@/server/http'
import { fail } from '@/server/command/result'
import { acceptOfferOnBehalf, acceptBehalfInput } from '@/server/commands/waitlist/respond'
import { idParam } from '@/server/queries/property/respond'

export const dynamic = 'force-dynamic'

/**
 * Reception or an Accommodation Admin accepts for the resident, with their consent recorded (D-52). The guard is "signed in" because two
 * policy actions allow it (Reception: accept_offer_on_behalf; AA and SA: manage_offers); the command checks which, and the site.
 */
export const POST = route({
  name: 'waitlist.offer.accept_on_behalf',
  access: { kind: 'authenticated' },
  body: acceptBehalfInput.omit({ offerId: true }),
  handler: (rc, body, _req, _r, { params }) => {
    const offerId = idParam(params)
    return offerId ? acceptOfferOnBehalf(rc, { ...body, offerId }) : Promise.resolve(fail.notFound())
  },
})
