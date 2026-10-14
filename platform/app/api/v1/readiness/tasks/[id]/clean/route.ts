import { route } from '@/server/http'
import { fail } from '@/server/command/result'
import { cleanInput, completeCleaning } from '@/server/commands/readiness/clean'
import { idParam } from '@/server/queries/property/respond'

export const dynamic = 'force-dynamic'

/** The assigned housekeeper records the cleaning: required checklist lines ticked, bed to Inspection required. Never Available. */
export const POST = route({
  name: 'readiness.task.clean',
  access: { kind: 'action', action: 'housekeeping_readiness.clean' },
  body: cleanInput.omit({ taskId: true }),
  handler: (rc, body, _req, _r, { params }) => {
    const id = idParam(params)
    return id ? completeCleaning(rc, { ...body, taskId: id }) : Promise.resolve(fail.notFound())
  },
})
