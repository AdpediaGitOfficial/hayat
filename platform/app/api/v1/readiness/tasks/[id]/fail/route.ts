import { route } from '@/server/http'
import { fail } from '@/server/command/result'
import { failInput, failInspection } from '@/server/commands/readiness/inspect'
import { idParam } from '@/server/queries/property/respond'

export const dynamic = 'force-dynamic'

/** A Final Inspection holder fails a cleaned room with a note: the bed returns to Needs cleaning and a new cleaning task opens. */
export const POST = route({
  name: 'readiness.task.fail',
  access: { kind: 'action', action: 'housekeeping_readiness.final_inspection' },
  body: failInput.omit({ taskId: true }),
  handler: (rc, body, _req, _r, { params }) => {
    const id = idParam(params)
    return id ? failInspection(rc, { ...body, taskId: id }) : Promise.resolve(fail.notFound())
  },
})
