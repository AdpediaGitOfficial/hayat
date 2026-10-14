import { route } from '@/server/http'
import { getDb } from '@/server/db/client'
import { fail, ok } from '@/server/command/result'
import { findForExit } from '@/server/queries/exit/find'

export const dynamic = 'force-dynamic'

/** Find a person by employee ID and preview what Mark as Left would do. Changes nothing. Out of scope reads as not found. */
export const GET = route({
  name: 'exit.find',
  access: { kind: 'action', action: 'exit_clearance.mark_left' },
  handler: async (rc, _b, req) => {
    const employeeId = new URL(req.url).searchParams.get('employeeId') ?? ''
    if (!employeeId.trim()) return fail.invalid('Enter an employee ID', { employeeId: 'Required' })
    const p = await findForExit(getDb(), rc.actor, employeeId)
    return p ? ok(p) : fail.notFound()
  },
})
