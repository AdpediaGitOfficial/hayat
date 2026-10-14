import { z } from 'zod'
import { route } from '@/server/http'
import { fail } from '@/server/command/result'
import { acceptOffer } from '@/server/commands/waitlist/respond'
import { idParam } from '@/server/queries/property/respond'

export const dynamic = 'force-dynamic'

/** The offered resident accepts: the held bed becomes their reservation. Retrying answers with the same reservation. */
export const POST = route({
  name: 'waitlist.offer.accept',
  access: { kind: 'action', action: 'requests_waitlist.respond_offer' },
  body: z.object({}),
  handler: (rc, _body, _req, _r, { params }) => {
    const offerId = idParam(params)
    return offerId ? acceptOffer(rc, { offerId }) : Promise.resolve(fail.notFound())
  },
})
