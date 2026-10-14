import { route } from '@/server/http'
import { fail } from '@/server/command/result'
import { confirmDelivery, deliveryInput } from '@/server/commands/waitlist/delivery'
import { idParam } from '@/server/queries/property/respond'

export const dynamic = 'force-dynamic'

/**
 * Records confirmed delivery of an offer, which starts the 48 hours (D-51): "informed offline" by Reception or the Accommodation Admin
 * (a note saying how and when is required), or email confirmed (placeholder for Stage 5). The guard is "signed in" because
 * Reception (record_offline_offer) and AA/SA (manage_offers) differ; the command checks which, and the site.
 */
export const POST = route({
  name: 'waitlist.offer.delivery',
  access: { kind: 'authenticated' },
  body: deliveryInput.omit({ offerId: true }),
  handler: (rc, body, _req, _r, { params }) => {
    const offerId = idParam(params)
    return offerId ? confirmDelivery(rc, { ...body, offerId }) : Promise.resolve(fail.notFound())
  },
})
