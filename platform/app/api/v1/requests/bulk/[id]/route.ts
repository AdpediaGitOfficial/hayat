import { route } from '@/server/http'
import { getDb } from '@/server/db/client'
import { fail } from '@/server/command/result'
import { getBulkBatch } from '@/server/queries/requests/bulk'
import { found, idParam } from '@/server/queries/property/respond'

export const dynamic = 'force-dynamic'

export const GET = route({
  name: 'bulk_allocation.detail',
  access: { kind: 'action', action: 'checkin_checkout.allocate_bulk' },
  handler: async (rc, _b, _req, _r, { params }) => {
    const id = idParam(params)
    return id ? found(await getBulkBatch(getDb(), rc.actor, id)) : fail.notFound()
  },
})
