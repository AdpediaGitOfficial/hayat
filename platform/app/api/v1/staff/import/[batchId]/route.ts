import { route } from '@/server/http'
import { getDb } from '@/server/db/client'
import { fail, ok } from '@/server/command/result'
import { getImportBatch } from '@/server/queries/staff/imports'
import { requireDirectory } from '@/server/commands/staff/guard'

export const dynamic = 'force-dynamic'

/** A batch with its rows: the preview, or the result once confirmed. Only for the person who uploaded it, or a Super Admin. */
export const GET = route({
  name: 'staff.import.get',
  access: { kind: 'action', action: 'staff_directory.import_csv' },
  handler: async (rc, _b, _req, _reply, { params }) => {
    const denied = requireDirectory(rc, 'staff_directory.import_csv')
    if (denied) return denied
    const b = await getImportBatch(getDb(), { actor: rc.actor, userId: rc.user.id }, params.batchId)
    return b ? ok(b) : fail.notFound()
  },
})
