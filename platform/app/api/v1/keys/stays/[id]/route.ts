import { route } from '@/server/http'
import { fail } from '@/server/command/result'
import { found, idParam } from '@/server/queries/property/respond'
import { keysForStay } from '@/server/queries/keys/items'

export const dynamic = 'force-dynamic'

/** The keys of one stay: what the person holds for this bed, what is left over from a bed they moved out of, and what is in the cabinet for it. */
export const GET = route({
  name: 'keys.for_stay',
  access: { kind: 'authenticated' },
  handler: async (rc, _b, _req, _r, { params }) => {
    const id = idParam(params)
    return id ? found(await keysForStay(rc.actor, id)) : fail.notFound()
  },
})
