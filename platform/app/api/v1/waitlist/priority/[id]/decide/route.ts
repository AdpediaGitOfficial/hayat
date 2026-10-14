import { route } from '@/server/http'
import { fail } from '@/server/command/result'
import { decidePriority, decideInput } from '@/server/commands/waitlist/priority'
import { idParam } from '@/server/queries/property/respond'

export const dynamic = 'force-dynamic'

/**
 * Policy Approver decision on a waitlist priority request. The guard is "signed in" because two policy actions can decide it
 * (the Policy Approver, and the named Backup Approver once it is routed to them); decidePriority() checks which, and the scope.
 * Never the person concerned and never the one who asked (D-26).
 */
export const POST = route({
  name: 'waitlist.priority.decide',
  access: { kind: 'authenticated' },
  body: decideInput.omit({ priorityRequestId: true }),
  handler: (rc, body, _req, _r, { params }) => {
    const priorityRequestId = idParam(params)
    return priorityRequestId ? decidePriority(rc, { ...body, priorityRequestId }) : Promise.resolve(fail.notFound())
  },
})
