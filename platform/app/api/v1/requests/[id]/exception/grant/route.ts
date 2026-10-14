import { route } from '@/server/http'
import { fail } from '@/server/command/result'
import { grantException, grantInput } from '@/server/commands/requests/exceptions'
import { idParam } from '@/server/queries/property/respond'

export const dynamic = 'force-dynamic'

/** A Policy Approver grants the exception. Reason and evidence are required; every use is recorded. */
export const POST = route({
  name: 'requests.exception.grant',
  access: { kind: 'action', action: 'requests_waitlist.approve_exception' },
  body: grantInput.omit({ requestId: true }),
  handler: (rc, body, _req, _r, { params }) => {
    const requestId = idParam(params)
    return requestId ? grantException(rc, { ...body, requestId }) : Promise.resolve(fail.notFound())
  },
})
