import { route } from '@/server/http'
import { fail } from '@/server/command/result'
import { editInput, editRequest } from '@/server/commands/requests/edit'
import { idParam } from '@/server/queries/property/respond'

export const dynamic = 'force-dynamic'

/** The requester changes a request that was sent back; "resubmit": true sends it back to the admin in the same step. */
export const POST = route({
  name: 'requests.edit',
  access: { kind: 'action', action: 'requests_waitlist.submit' },
  body: editInput.omit({ requestId: true }),
  handler: (rc, body, _req, _r, { params }) => {
    const requestId = idParam(params)
    return requestId ? editRequest(rc, { ...body, requestId }) : Promise.resolve(fail.notFound())
  },
})
