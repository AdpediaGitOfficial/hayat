import { route } from '@/server/http'
import { fail } from '@/server/command/result'
import { getBedDetail } from '@/server/queries/property/detail'
import { found, idParam } from '@/server/queries/property/respond'

export const dynamic = 'force-dynamic'

/** One bed: physical state, the block in force, and its upcoming claims (read-only). Outside the actor's sites it is a 404. */
export const GET = route({
  name: 'property.bed.get',
  access: { kind: 'action', action: 'rooms_beds.view' },
  handler: async (rc, _b, _req, _r, { params }) => {
    const id = idParam(params)
    return id ? found(await getBedDetail(rc.actor, id)) : fail.notFound()
  },
})
