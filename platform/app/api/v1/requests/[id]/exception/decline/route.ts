import { route } from '@/server/http'
import { fail } from '@/server/command/result'
import { declineException, declineInput } from '@/server/commands/requests/exceptions'
import { idParam } from '@/server/queries/property/respond'

export const dynamic = 'force-dynamic'

/** A Policy Approver declines the exception; the request goes back to the Accommodation Admin. */
export const POST = route({
  name: 'requests.exception.decline',
  access: { kind: 'action', action: 'requests_waitlist.approve_exception' },
  body: declineInput.omit({ requestId: true }),
  handler: (rc, body, _req, _r, { params }) => {
    const requestId = idParam(params)
    return requestId ? declineException(rc, { ...body, requestId }) : Promise.resolve(fail.notFound())
  },
})
