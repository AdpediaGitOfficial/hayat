import { route } from '@/server/http'
import { fail } from '@/server/command/result'
import { approveExtension, approveInput } from '@/server/commands/stays/extension'
import { idParam } from '@/server/queries/property/respond'

export const dynamic = 'force-dynamic'

/** Approve an extension: within policy the Accommodation Admin, beyond policy the Policy Approver. Revalidated at this moment. */
export const POST = route({
  name: 'stays.extension.approve',
  access: { kind: 'action', action: 'approvals_inbox.view' },
  body: approveInput.omit({ id: true }),
  handler: (rc, body, _req, _r, { params }) => {
    const id = idParam(params)
    return id ? approveExtension(rc, { ...body, id: id }) : Promise.resolve(fail.notFound())
  },
})
