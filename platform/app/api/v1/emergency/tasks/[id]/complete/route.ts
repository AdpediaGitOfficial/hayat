import { route } from '@/server/http'
import { fail } from '@/server/command/result'
import { completeTask, completeTaskInput } from '@/server/commands/emergency/completeTask'
import { idParam } from '@/server/queries/property/respond'

export const dynamic = 'force-dynamic'

/** An Accommodation Admin marks the relocation or checkout task done, once the resident has been dealt with by a person. */
export const POST = route({
  name: 'emergency.task_complete',
  access: { kind: 'action', action: 'emergency_checkin.approve' },
  body: completeTaskInput.omit({ taskId: true }),
  handler: (rc, body, _req, _r, { params }) => {
    const taskId = idParam(params)
    return taskId ? completeTask(rc, { ...body, taskId }) : Promise.resolve(fail.notFound())
  },
})
