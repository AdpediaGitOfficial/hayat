import { route } from '@/server/http'
import { fail, ok } from '@/server/command/result'
import { destinationOptions } from '@/server/queries/stays/stays'
import { idParam } from '@/server/queries/property/respond'

export const dynamic = 'force-dynamic'

/**
 * The beds of a destination site (D-104) that are ready and free for the rest of this stay, each with whether this person may have it
 * under that site's rules and why not, in plain words. For whoever may ask for the move; a stay out of scope is "not found".
 */
export const GET = route({
  name: 'stays.transfer.options',
  access: { kind: 'action', action: 'reservations_stays.view' },
  handler: async (rc, _body, req, _r, { params }) => {
    const id = idParam(params)
    const siteId = new URL(req.url).searchParams.get('siteId')
    if (!id || !siteId) return fail.notFound()
    const options = await destinationOptions(rc.actor, id, siteId, rc.clock.now())
    return options ? ok(options) : fail.notFound()
  },
})
