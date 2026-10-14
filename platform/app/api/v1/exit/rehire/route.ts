import { route } from '@/server/http'
import { getDb } from '@/server/db/client'
import { fail, ok } from '@/server/command/result'
import { reactivateStaff, rehireInput } from '@/server/commands/exit/rehire'
import { findForRehire } from '@/server/queries/exit/rehire'

export const dynamic = 'force-dynamic'

/** Find a former employee by employee ID and show what stands in the way of rehiring them. Changes nothing. */
export const GET = route({
  name: 'exit.rehire_find',
  access: { kind: 'action', action: 'staff_directory.manage' },
  handler: async (rc, _b, req) => {
    const employeeId = new URL(req.url).searchParams.get('employeeId') ?? ''
    if (!employeeId.trim()) return fail.invalid('Enter an employee ID', { employeeId: 'Required' })
    const p = await findForRehire(getDb(), rc.actor, employeeId)
    return p ? ok(p) : fail.notFound()
  },
})

/** Rehire (D-41, AT-032): reactivates the existing profile. Blocked while an old clearance case is open (unless resolved) or a stay is not checked out. */
export const POST = route({
  name: 'exit.rehire',
  access: { kind: 'action', action: 'staff_directory.manage' },
  body: rehireInput,
  handler: (rc, body) => reactivateStaff(rc, body),
})
