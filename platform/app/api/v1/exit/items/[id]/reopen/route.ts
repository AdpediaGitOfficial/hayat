import { route } from '@/server/http'
import { fail } from '@/server/command/result'
import { reopenItem, reopenInput } from '@/server/commands/exit/items'
import { idParam } from '@/server/queries/property/respond'

export const dynamic = 'force-dynamic'

/** Reopen a done or outstanding item (Accommodation Admin, with a reason). A waiver is final. */
export const POST = route({
  name: 'exit.item_reopen',
  access: { kind: 'action', action: 'exit_clearance.manage_case' },
  body: reopenInput.omit({ itemId: true }),
  handler: (rc, body, _req, _r, { params }) => {
    const id = idParam(params)
    return id ? reopenItem(rc, { ...body, itemId: id }) : Promise.resolve(fail.notFound())
  },
})
