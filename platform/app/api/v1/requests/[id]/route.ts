import { route } from '@/server/http'
import { getDb } from '@/server/db/client'
import { fail } from '@/server/command/result'
import { getRequestDetail } from '@/server/queries/requests/detail'
import { found, idParam } from '@/server/queries/property/respond'

export const dynamic = 'force-dynamic'

export const GET = route({
  name: 'requests.detail',
  access: { kind: 'action', action: 'requests_waitlist.view' },
  handler: async (rc, _b, _req, _r, { params }) => {
    const id = idParam(params)
    return id ? found(await getRequestDetail(getDb(), rc, id, rc.clock.now())) : fail.notFound()
  },
})
