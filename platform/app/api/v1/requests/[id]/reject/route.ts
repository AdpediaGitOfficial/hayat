import { route } from '@/server/http'
import { fail } from '@/server/command/result'
import { decisionInput, rejectRequest } from '@/server/commands/requests/decide'
import { idParam } from '@/server/queries/property/respond'

export const dynamic = 'force-dynamic'

/** Reject with a reason; the resident is told. */
export const POST = route({
  name: 'requests.reject',
  access: { kind: 'action', action: 'approvals_inbox.view' },
  body: decisionInput.omit({ requestId: true }),
  handler: (rc, body, _req, _r, { params }) => {
    const requestId = idParam(params)
    return requestId ? rejectRequest(rc, { ...body, requestId }) : Promise.resolve(fail.notFound())
  },
})
