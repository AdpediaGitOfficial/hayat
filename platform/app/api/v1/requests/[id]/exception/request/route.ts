import { route } from '@/server/http'
import { fail } from '@/server/command/result'
import { askInput, requestException } from '@/server/commands/requests/exceptions'
import { idParam } from '@/server/queries/property/respond'

export const dynamic = 'force-dynamic'

/** The Accommodation Admin asks a Policy Approver for a gender or grade exception. */
export const POST = route({
  name: 'requests.exception.request',
  access: { kind: 'action', action: 'requests_waitlist.approve' },
  body: askInput.omit({ requestId: true }),
  handler: (rc, body, _req, _r, { params }) => {
    const requestId = idParam(params)
    return requestId ? requestException(rc, { ...body, requestId }) : Promise.resolve(fail.notFound())
  },
})
