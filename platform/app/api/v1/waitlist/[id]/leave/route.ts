import { route } from '@/server/http'
import { fail } from '@/server/command/result'
import { leaveWaitlist, input } from '@/server/commands/waitlist/leave'
import { idParam } from '@/server/queries/property/respond'

export const dynamic = 'force-dynamic'

/** Take a person off the waitlist (the person, or Reception / the Accommodation Admin for them). A pending offer is withdrawn. */
export const POST = route({
  name: 'waitlist.leave',
  access: { kind: 'action', action: 'requests_waitlist.submit' },
  body: input.omit({ entryId: true }),
  handler: (rc, body, _req, _r, { params }) => {
    const entryId = idParam(params)
    return entryId ? leaveWaitlist(rc, { ...body, entryId }) : Promise.resolve(fail.notFound())
  },
})
