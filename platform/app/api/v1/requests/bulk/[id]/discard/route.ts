import { route } from '@/server/http'
import { fail } from '@/server/command/result'
import { discardBulkAllocation } from '@/server/commands/allocation-admin/bulk'
import { idParam } from '@/server/queries/property/respond'

export const dynamic = 'force-dynamic'

export const POST = route({
  name: 'bulk_allocation.discard',
  method: 'POST',
  access: { kind: 'action', action: 'checkin_checkout.allocate_bulk' },
  handler: (rc, _b, _req, _r, { params }) => {
    const batchId = idParam(params)
    return batchId ? discardBulkAllocation(rc, { batchId }) : Promise.resolve(fail.notFound())
  },
})
