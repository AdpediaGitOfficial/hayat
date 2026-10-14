import { route } from '@/server/http'
import { fail } from '@/server/command/result'
import { executeTransfer, input } from '@/server/commands/stays/executeTransfer'
import { idParam } from '@/server/queries/property/respond'

export const dynamic = 'force-dynamic'

/** Carry out an approved transfer or swap atomically. If the destination became unavailable it fails safely and nothing moves (AT-022). */
export const POST = route({
  name: 'stays.transfer.execute',
  access: { kind: 'action', action: 'transfers_swaps.execute' },
  body: input.omit({ id: true }),
  handler: (rc, body, _req, _r, { params }) => {
    const id = idParam(params)
    return id ? executeTransfer(rc, { ...body, id: id }) : Promise.resolve(fail.notFound())
  },
})
