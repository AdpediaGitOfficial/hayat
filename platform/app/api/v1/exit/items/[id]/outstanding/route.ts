import { route } from '@/server/http'
import { fail } from '@/server/command/result'
import { markOutstanding, outstandingInput } from '@/server/commands/exit/items'
import { idParam } from '@/server/queries/property/respond'

export const dynamic = 'force-dynamic'

/** A mandatory item that cannot be done now: Outstanding, with a note and the owner who follows it up (SRS 5.6 step 32). */
export const POST = route({
  name: 'exit.item_outstanding',
  access: { kind: 'action', action: 'exit_clearance.view' },
  body: outstandingInput.omit({ itemId: true }),
  handler: (rc, body, _req, _r, { params }) => {
    const id = idParam(params)
    return id ? markOutstanding(rc, { ...body, itemId: id }) : Promise.resolve(fail.notFound())
  },
})
