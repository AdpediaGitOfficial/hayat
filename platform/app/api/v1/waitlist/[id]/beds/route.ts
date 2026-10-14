import { route } from '@/server/http'
import { getDb } from '@/server/db/client'
import { fail } from '@/server/command/result'
import { found, idParam } from '@/server/queries/property/respond'
import { offerCandidates } from '@/server/queries/waitlist/queue'

export const dynamic = 'force-dynamic'

/** Beds that could be offered to this waitlisted person, ready beds first. */
export const GET = route({
  name: 'waitlist.offer.candidates',
  access: { kind: 'action', action: 'requests_waitlist.manage_offers' },
  handler: async (rc, _b, _req, _r, { params }) => {
    const entryId = idParam(params)
    return entryId ? found(await offerCandidates(getDb(), rc.actor, entryId, rc.clock.now())) : fail.notFound()
  },
})
