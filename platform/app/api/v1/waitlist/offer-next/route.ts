import { route } from '@/server/http'
import { offerToNext, nextInput } from '@/server/commands/waitlist/offer'

export const dynamic = 'force-dynamic'

/** "Offer to the next in queue": the next eligible waitlisted person gets this bed held for them. */
export const POST = route({
  name: 'waitlist.offer.next',
  access: { kind: 'action', action: 'requests_waitlist.manage_offers' },
  body: nextInput,
  handler: (rc, body) => offerToNext(rc, body),
})
