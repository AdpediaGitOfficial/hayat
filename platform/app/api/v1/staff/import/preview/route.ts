import { route } from '@/server/http'
import { previewStaffImport, input } from '@/server/commands/staff/importPreview'

export const dynamic = 'force-dynamic'

/** Step 1 of the CSV import. Body: { csv: "<file text>", fileName?: string }, at most 2 MB and 5 000 rows. Saves nothing to the directory. */
export const POST = route({
  name: 'staff.import.preview',
  access: { kind: 'action', action: 'staff_directory.import_csv' },
  body: input,
  handler: (rc, body) => previewStaffImport(rc, body),
})
