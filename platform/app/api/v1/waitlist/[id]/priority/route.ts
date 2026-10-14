import { route } from '@/server/http'
import { fail } from '@/server/command/result'
import { requestPriority, requestInput } from '@/server/commands/waitlist/priority'
import { idParam } from '@/server/queries/property/respond'

export const dynamic = 'force-dynamic'

/** Ask for a priority category for a waitlisted person (Accommodation Admin). A Policy Approver decides, with reason and evidence on record. */
export const POST = route({
  name: 'waitlist.priority.request',
  access: { kind: 'action', action: 'requests_waitlist.manage_waitlist' },
  body: requestInput.omit({ entryId: true }),
  handler: (rc, body, _req, _r, { params }) => {
    const entryId = idParam(params)
    return entryId ? requestPriority(rc, { ...body, entryId }) : Promise.resolve(fail.notFound())
  },
})
