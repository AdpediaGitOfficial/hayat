import { route } from '@/server/http'
import { confirmStaffImport } from '@/server/commands/staff/importConfirm'

export const dynamic = 'force-dynamic'

/** Step 2 of the CSV import: saves the valid rows once. Confirming again, or at the same moment, saves nothing more (409). */
export const POST = route({
  name: 'staff.import.confirm',
  method: 'POST',
  access: { kind: 'action', action: 'staff_directory.import_csv' },
  handler: (rc, _b, _req, _reply, { params }) => confirmStaffImport(rc, { batchId: params.batchId }),
})
