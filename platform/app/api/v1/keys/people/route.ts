import { route } from '@/server/http'
import { fail, ok } from '@/server/command/result'
import { findKeyPerson } from '@/server/queries/keys/items'

export const dynamic = 'force-dynamic'

/** Finds a person by employee ID at the desk: name, whether they may be given this item, and why not. Only those who hand items out. */
export const GET = route({
  name: 'keys.find_person',
  access: { kind: 'authenticated' },
  handler: async (rc, _b, req) => {
    const u = new URL(req.url).searchParams
    const employeeId = u.get('employeeId') ?? ''
    if (!employeeId.trim()) return fail.invalid('Enter an employee ID', { employeeId: 'Required' })
    const p = await findKeyPerson(rc.actor, employeeId, u.get('itemId') ?? undefined)
    return p ? ok(p) : fail.notFound()
  },
})
