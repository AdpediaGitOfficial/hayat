import { route } from '@/server/http'
import { fail } from '@/server/command/result'
import { assignCleaning, assignInput } from '@/server/commands/readiness/assign'
import { idParam } from '@/server/queries/property/respond'

export const dynamic = 'force-dynamic'

/** Reception or the Super Admin gives an open cleaning task to a housekeeper (active Housekeeping grant, not the person living in that room). Reassigning needs a reason. */
export const POST = route({
  name: 'readiness.task.assign',
  access: { kind: 'action', action: 'housekeeping_readiness.assign' },
  body: assignInput.omit({ taskId: true }),
  handler: (rc, body, _req, _r, { params }) => {
    const id = idParam(params)
    return id ? assignCleaning(rc, { ...body, taskId: id }) : Promise.resolve(fail.notFound())
  },
})
