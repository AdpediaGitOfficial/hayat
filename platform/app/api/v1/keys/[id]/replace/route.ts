import { route } from '@/server/http'
import { fail } from '@/server/command/result'
import { replaceItem, replaceInput } from '@/server/commands/keys/movements'
import { idParam } from '@/server/queries/property/respond'

export const dynamic = 'force-dynamic'

/** Replaces a lost or damaged item: the old one is retired and linked to the new one (D-73). */
export const POST = route({
  name: 'keys.replace',
  access: { kind: 'action', action: 'keys.manage' },
  body: replaceInput.omit({ itemId: true }),
  handler: (rc, body, _req, _r, { params }) => {
    const id = idParam(params)
    return id ? replaceItem(rc, { ...body, itemId: id }) : Promise.resolve(fail.notFound())
  },
})
