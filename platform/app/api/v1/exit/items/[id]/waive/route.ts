import { route } from '@/server/http'
import { fail } from '@/server/command/result'
import { waiveItem, waiveInput } from '@/server/commands/exit/items'
import { idParam } from '@/server/queries/property/respond'

export const dynamic = 'force-dynamic'

/** The clearance waiver (D-71): Policy Approver only; reason AND evidence mandatory; the password is re-confirmed; audited. */
export const POST = route({
  name: 'exit.item_waive',
  access: { kind: 'action', action: 'exit_clearance.waive' },
  body: waiveInput.omit({ itemId: true }),
  handler: (rc, body, _req, _r, { params }) => {
    const id = idParam(params)
    return id ? waiveItem(rc, { ...body, itemId: id }) : Promise.resolve(fail.notFound())
  },
})
