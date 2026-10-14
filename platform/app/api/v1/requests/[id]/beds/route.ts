import { route } from '@/server/http'
import { getDb } from '@/server/db/client'
import { fail } from '@/server/command/result'
import { bedsForRequest } from '@/server/queries/requests/beds'
import { found, idParam } from '@/server/queries/property/respond'

export const dynamic = 'force-dynamic'

/** Suggested beds (eligible and free for the request's dates) and the site's other beds, for the approval screen. */
export const GET = route({
  name: 'requests.beds',
  access: { kind: 'action', action: 'approvals_inbox.view' },
  handler: async (rc, _b, _req, _r, { params }) => {
    const id = idParam(params)
    return id ? found(await bedsForRequest(getDb(), rc.actor, id, rc.clock.now())) : fail.notFound()
  },
})
