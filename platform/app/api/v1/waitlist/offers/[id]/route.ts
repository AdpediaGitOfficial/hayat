import { route } from '@/server/http'
import { fail } from '@/server/command/result'
import { viewOffer } from '@/server/commands/waitlist/delivery'
import { idParam } from '@/server/queries/property/respond'

export const dynamic = 'force-dynamic'

/**
 * Reads a bed offer. When the OFFERED RESIDENT opens it, that is confirmed delivery and the 48-hour window starts (first read only).
 * Staff reading it start nothing.
 */
export const GET = route({
  name: 'waitlist.offer.view',
  access: { kind: 'action', action: 'requests_waitlist.view' },
  handler: (rc, _b, _req, _r, { params }) => {
    const offerId = idParam(params)
    return offerId ? viewOffer(rc, { offerId }) : Promise.resolve(fail.notFound())
  },
})
