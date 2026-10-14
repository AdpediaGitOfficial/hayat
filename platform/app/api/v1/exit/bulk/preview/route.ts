import { route } from '@/server/http'
import { previewBulkExit, previewInput } from '@/server/commands/exit/bulk'

export const dynamic = 'force-dynamic'

/** Bulk exit step 1 (D-38): per-row outcome for a list of employee IDs or CSV text. Stores the preview; nobody is changed. */
export const POST = route({
  name: 'exit.bulk_preview',
  access: { kind: 'action', action: 'exit_clearance.mark_left' },
  body: previewInput,
  handler: (rc, body) => previewBulkExit(rc, body),
})
