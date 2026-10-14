import { route } from '@/server/http'
import { fail } from '@/server/command/result'
import { passInput, passInspection } from '@/server/commands/readiness/inspect'
import { idParam } from '@/server/queries/property/respond'

export const dynamic = 'force-dynamic'

/** A Final Inspection holder passes a cleaned room (never their own, never one they cleaned): the only way a bed becomes Available. */
export const POST = route({
  name: 'readiness.task.pass',
  access: { kind: 'action', action: 'housekeeping_readiness.final_inspection' },
  body: passInput.omit({ taskId: true }),
  handler: (rc, body, _req, _r, { params }) => {
    const id = idParam(params)
    return id ? passInspection(rc, { ...body, taskId: id }) : Promise.resolve(fail.notFound())
  },
})
