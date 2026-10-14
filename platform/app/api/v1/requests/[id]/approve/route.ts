import { route } from '@/server/http'
import { fail } from '@/server/command/result'
import { approveInput, approveRequest } from '@/server/commands/requests/approve'
import { idParam } from '@/server/queries/property/respond'

export const dynamic = 'force-dynamic'

/** Approval = pick the bed and create the reservation, atomically (D-44). */
export const POST = route({
  name: 'requests.approve',
  access: { kind: 'action', action: 'approvals_inbox.view' },
  body: approveInput.omit({ requestId: true }),
  handler: (rc, body, _req, _r, { params }) => {
    const requestId = idParam(params)
    return requestId ? approveRequest(rc, { ...body, requestId }) : Promise.resolve(fail.notFound())
  },
})
