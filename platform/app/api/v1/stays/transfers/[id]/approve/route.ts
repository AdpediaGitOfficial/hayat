import { route } from '@/server/http'
import { fail } from '@/server/command/result'
import { approveTransfer, approveInput } from '@/server/commands/stays/decideTransfer'
import { idParam } from '@/server/queries/property/respond'

export const dynamic = 'force-dynamic'

/** An Accommodation Admin (or, once escalated, a backup approver) approves; never the people it is about or who raised it (D-26). */
export const POST = route({
  name: 'stays.transfer.approve',
  access: { kind: 'action', action: 'approvals_inbox.view' },
  body: approveInput.omit({ id: true }),
  handler: (rc, body, _req, _r, { params }) => {
    const id = idParam(params)
    return id ? approveTransfer(rc, { ...body, id: id }) : Promise.resolve(fail.notFound())
  },
})
