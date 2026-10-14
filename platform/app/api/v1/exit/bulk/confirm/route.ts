import { route } from '@/server/http'
import { confirmBulkExit, confirmInput } from '@/server/commands/exit/bulk'

export const dynamic = 'force-dynamic'

/** Bulk exit step 2: re-confirm the password once, then each row is its own Mark as Left. Safe to repeat: done rows are skipped. */
export const POST = route({
  name: 'exit.bulk_confirm',
  access: { kind: 'action', action: 'exit_clearance.mark_left' },
  body: confirmInput,
  handler: (rc, body) => confirmBulkExit(rc, body),
})
