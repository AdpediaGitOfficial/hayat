import { route } from '@/server/http'
import { fail } from '@/server/command/result'
import { archiveItem, archiveInput } from '@/server/commands/keys/registry'
import { idParam } from '@/server/queries/property/respond'

export const dynamic = 'force-dynamic'

/** Archives a returned or retired item (frees its code). Never while issued, lost or damaged. */
export const POST = route({
  name: 'keys.archive',
  access: { kind: 'action', action: 'keys.manage' },
  body: archiveInput.omit({ id: true }),
  handler: (rc, body, _req, _r, { params }) => {
    const id = idParam(params)
    return id ? archiveItem(rc, { ...body, id: id }) : Promise.resolve(fail.notFound())
  },
})
