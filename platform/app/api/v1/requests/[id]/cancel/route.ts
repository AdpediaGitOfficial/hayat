import { route } from '@/server/http'
import { fail } from '@/server/command/result'
import { cancelInput, cancelRequest } from '@/server/commands/requests/cancel'
import { idParam } from '@/server/queries/property/respond'

export const dynamic = 'force-dynamic'

/** Withdraw a request (the requester, or an Accommodation Admin). A reason is required. */
export const POST = route({
  name: 'requests.cancel',
  access: { kind: 'action', action: 'requests_waitlist.submit' },
  body: cancelInput.omit({ requestId: true }),
  handler: (rc, body, _req, _r, { params }) => {
    const requestId = idParam(params)
    return requestId ? cancelRequest(rc, { ...body, requestId }) : Promise.resolve(fail.notFound())
  },
})
