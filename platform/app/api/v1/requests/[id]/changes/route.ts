import { route } from '@/server/http'
import { fail } from '@/server/command/result'
import { decisionInput, requestChanges } from '@/server/commands/requests/decide'
import { idParam } from '@/server/queries/property/respond'

export const dynamic = 'force-dynamic'

/** Send the request back to the requester with a reason. */
export const POST = route({
  name: 'requests.changes',
  access: { kind: 'action', action: 'approvals_inbox.view' },
  body: decisionInput.omit({ requestId: true }),
  handler: (rc, body, _req, _r, { params }) => {
    const requestId = idParam(params)
    return requestId ? requestChanges(rc, { ...body, requestId }) : Promise.resolve(fail.notFound())
  },
})
