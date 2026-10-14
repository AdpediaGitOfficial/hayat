import { route } from '@/server/http'
import { previewBulkAllocation, previewInput } from '@/server/commands/allocation-admin/bulk'

export const dynamic = 'force-dynamic'

/** Select requests, auto-match beds and store a preview. Reserves nothing (D-60). */
export const POST = route({
  name: 'bulk_allocation.preview',
  access: { kind: 'action', action: 'checkin_checkout.allocate_bulk' },
  body: previewInput,
  handler: (rc, body) => previewBulkAllocation(rc, body),
})
