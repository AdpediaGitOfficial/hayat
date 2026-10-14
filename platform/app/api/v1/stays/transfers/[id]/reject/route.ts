import { route } from '@/server/http'
import { fail } from '@/server/command/result'
import { rejectTransfer, rejectInput } from '@/server/commands/stays/decideTransfer'
import { idParam } from '@/server/queries/property/respond'

export const dynamic = 'force-dynamic'

/** Reject with a reason. Nobody is moved. */
export const POST = route({
  name: 'stays.transfer.reject',
  access: { kind: 'action', action: 'transfers_swaps.view' },
  body: rejectInput.omit({ id: true }),
  handler: (rc, body, _req, _r, { params }) => {
    const id = idParam(params)
    return id ? rejectTransfer(rc, { ...body, id: id }) : Promise.resolve(fail.notFound())
  },
})
