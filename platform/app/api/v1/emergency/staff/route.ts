import { route } from '@/server/http'
import { getDb } from '@/server/db/client'
import { fail, ok } from '@/server/command/result'
import { findPerson } from '@/server/queries/emergency/pick'

export const dynamic = 'force-dynamic'

/** Find the person by employee ID for the initiate form: name, department and whether they already have a stay. Nothing more. */
export const GET = route({
  name: 'emergency.find_person',
  access: { kind: 'action', action: 'emergency_checkin.initiate' },
  handler: async (rc, _b, req) => {
    const employeeId = new URL(req.url).searchParams.get('employeeId') ?? ''
    if (!employeeId.trim()) return fail.invalid('Enter an employee ID', { employeeId: 'Required' })
    const p = await findPerson(getDb(), rc.actor, employeeId)
    return p ? ok(p) : fail.notFound()
  },
})
