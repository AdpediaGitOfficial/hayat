import { route } from '@/server/http'
import { fail } from '@/server/command/result'
import { cancelInput, cancelTask } from '@/server/commands/readiness/assign'
import { idParam } from '@/server/queries/property/respond'

export const dynamic = 'force-dynamic'

/** Cancels a task that no longer matches its bed (blocked, leaving use). A task its bed still needs cannot be cancelled. */
export const POST = route({
  name: 'readiness.task.cancel',
  access: { kind: 'action', action: 'housekeeping_readiness.assign' },
  body: cancelInput.omit({ taskId: true }),
  handler: (rc, body, _req, _r, { params }) => {
    const id = idParam(params)
    return id ? cancelTask(rc, { ...body, taskId: id }) : Promise.resolve(fail.notFound())
  },
})
