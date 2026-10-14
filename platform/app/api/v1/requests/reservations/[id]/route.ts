import { route } from '@/server/http'
import { getDb } from '@/server/db/client'
import { fail } from '@/server/command/result'
import { getReservation } from '@/server/queries/requests/reservations'
import { found, idParam } from '@/server/queries/property/respond'

export const dynamic = 'force-dynamic'

export const GET = route({
  name: 'reservations.detail',
  access: { kind: 'action', action: 'reservations_stays.view' },
  handler: async (rc, _b, _req, _r, { params }) => {
    const id = idParam(params)
    return id ? found(await getReservation(getDb(), rc.actor, id)) : fail.notFound()
  },
})
