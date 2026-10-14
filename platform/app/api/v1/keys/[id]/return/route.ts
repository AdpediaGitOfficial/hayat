import { route } from '@/server/http'
import { fail } from '@/server/command/result'
import { returnItem, returnInput } from '@/server/commands/keys/movements'
import { idParam } from '@/server/queries/property/respond'

export const dynamic = 'force-dynamic'

/** Takes an issued item back. A lost or damaged item is never returned here (D-73). */
export const POST = route({
  name: 'keys.return',
  access: { kind: 'authenticated' },
  body: returnInput.omit({ itemId: true }),
  handler: (rc, body, _req, _r, { params }) => {
    const id = idParam(params)
    return id ? returnItem(rc, { ...body, itemId: id }) : Promise.resolve(fail.notFound())
  },
})
