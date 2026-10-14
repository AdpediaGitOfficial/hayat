import { route } from '@/server/http'
import { getDb } from '@/server/db/client'
import { fail, ok } from '@/server/command/result'
import { getExitBatch } from '@/server/queries/exit/bulk'
import { idParam } from '@/server/queries/property/respond'

export const dynamic = 'force-dynamic'

/** A stored bulk-exit preview or result. Only the person who made it can read it. */
export const GET = route({
  name: 'exit.bulk_get',
  access: { kind: 'action', action: 'exit_clearance.mark_left' },
  handler: async (rc, _b, _req, _r, { params }) => {
    const id = idParam(params)
    const b = id ? await getExitBatch(getDb(), rc.actor, rc.user.id, id) : undefined
    return b ? ok(b) : fail.notFound()
  },
})
