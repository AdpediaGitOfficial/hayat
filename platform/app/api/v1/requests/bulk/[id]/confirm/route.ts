import { route } from '@/server/http'
import { fail } from '@/server/command/result'
import { confirmBulkAllocation } from '@/server/commands/allocation-admin/bulk'
import { idParam } from '@/server/queries/property/respond'

export const dynamic = 'force-dynamic'

/** Reserve the stored rows one by one. Safe to repeat: rows already done are skipped, failed rows are retried. */
export const POST = route({
  name: 'bulk_allocation.confirm',
  method: 'POST',
  access: { kind: 'action', action: 'checkin_checkout.allocate_bulk' },
  handler: (rc, _b, _req, _r, { params }) => {
    const batchId = idParam(params)
    return batchId ? confirmBulkAllocation(rc, { batchId }) : Promise.resolve(fail.notFound())
  },
})
