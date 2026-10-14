import { route } from '@/server/http'
import { fail } from '@/server/command/result'
import { completeItem, completeInput } from '@/server/commands/exit/items'
import { idParam } from '@/server/queries/property/respond'

export const dynamic = 'force-dynamic'

/**
 * Complete a clearance item on the former employee's behalf (actor and "on behalf of" are recorded). The route lets everyone who sees
 * clearance in; the command decides precisely (Maintenance items: the Maintenance Coordinator only; the rest: Reception, AA, SA).
 */
export const POST = route({
  name: 'exit.item_complete',
  access: { kind: 'action', action: 'exit_clearance.view' },
  body: completeInput.omit({ itemId: true }),
  handler: (rc, body, _req, _r, { params }) => {
    const id = idParam(params)
    return id ? completeItem(rc, { ...body, itemId: id }) : Promise.resolve(fail.notFound())
  },
})
