import { route } from '@/server/http'
import { fail } from '@/server/command/result'
import { found, idParam } from '@/server/queries/property/respond'
import { getStayDetail } from '@/server/queries/stays/stays'

export const dynamic = 'force-dynamic'

export const GET = route({
  name: 'stays.detail',
  access: { kind: 'action', action: 'reservations_stays.view' },
  handler: async (rc, _b, _req, _r, { params }) => {
    const id = idParam(params)
    return id ? found(await getStayDetail(rc.actor, id)) : fail.notFound()
  },
})
