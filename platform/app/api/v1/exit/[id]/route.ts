import { route } from '@/server/http'
import { getDb } from '@/server/db/client'
import { fail, ok } from '@/server/command/result'
import { getCase } from '@/server/queries/exit/cases'
import { idParam } from '@/server/queries/property/respond'

export const dynamic = 'force-dynamic'

/** One clearance case with its items (keys read live), history, and what the caller may do. Out of scope reads as not found. */
export const GET = route({
  name: 'exit.get',
  access: { kind: 'action', action: 'exit_clearance.view' },
  handler: async (rc, _b, _req, _r, { params }) => {
    const id = idParam(params)
    const c = id ? await getCase(getDb(), rc.actor, id, rc.clock.now()) : undefined
    return c ? ok(c) : fail.notFound()
  },
})
