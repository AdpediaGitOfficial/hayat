import { route } from '@/server/http'
import { fail } from '@/server/command/result'
import { issueItem, issueInput } from '@/server/commands/keys/movements'
import { idParam } from '@/server/queries/property/respond'

export const dynamic = 'force-dynamic'

/** Hands the item to a person (Reception, Night Keys holders, administrators; the command checks the site and never to oneself). */
export const POST = route({
  name: 'keys.issue',
  access: { kind: 'authenticated' },
  body: issueInput.omit({ itemId: true }),
  handler: (rc, body, _req, _r, { params }) => {
    const id = idParam(params)
    return id ? issueItem(rc, { ...body, itemId: id }) : Promise.resolve(fail.notFound())
  },
})
