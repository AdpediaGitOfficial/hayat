import { route } from '@/server/http'
import { fail } from '@/server/command/result'
import { rejectExtension, rejectInput } from '@/server/commands/stays/extension'
import { idParam } from '@/server/queries/property/respond'

export const dynamic = 'force-dynamic'

/** Reject an extension with a reason. */
export const POST = route({
  name: 'stays.extension.reject',
  access: { kind: 'action', action: 'approvals_inbox.view' },
  body: rejectInput.omit({ id: true }),
  handler: (rc, body, _req, _r, { params }) => {
    const id = idParam(params)
    return id ? rejectExtension(rc, { ...body, id: id }) : Promise.resolve(fail.notFound())
  },
})
