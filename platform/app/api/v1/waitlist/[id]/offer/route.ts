import { route } from '@/server/http'
import { fail } from '@/server/command/result'
import { createOffer, createInput } from '@/server/commands/waitlist/offer'
import { idParam } from '@/server/queries/property/respond'

export const dynamic = 'force-dynamic'

/** Offer a bed to this waitlisted person. The bed is held; the 48 hours start when delivery is confirmed. */
export const POST = route({
  name: 'waitlist.offer.create',
  access: { kind: 'action', action: 'requests_waitlist.manage_offers' },
  body: createInput.omit({ entryId: true }),
  // Only the queue override (skipping someone who is ahead) re-asks for the password (D-03, P-02 pending sign-off).
  reauth: { action: 'waitlist.queue_override', when: b => !!b.overrideReason },
  handler: (rc, body, _req, _r, { params }) => {
    const entryId = idParam(params)
    return entryId ? createOffer(rc, { ...body, entryId }) : Promise.resolve(fail.notFound())
  },
})
