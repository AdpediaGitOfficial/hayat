import { route } from '@/server/http'
import { getDb } from '@/server/db/client'
import { fail, ok } from '@/server/command/result'
import { listStaff } from '@/server/queries/staff/list'
import { createStaff, input as createInput } from '@/server/commands/staff/create'

export const dynamic = 'force-dynamic'

/**
 * The staff directory, in the shape the acting role may see (AT-001). The guard is "any signed-in user" because four
 * different policy actions can read it (view, lookup_minimum, identity_check, view_own); listStaff() picks the strongest
 * one the actor holds and answers 403 when they hold none. tests/api/staff covers every role.
 */
export const GET = route({
  name: 'staff.list',
  access: { kind: 'authenticated' },
  handler: async (rc, _b, req) => {
    const u = new URL(req.url).searchParams
    const num = (k: string) => (u.has(k) && u.get(k) !== '' ? Number(u.get(k)) : undefined)
    const status = u.get('status')
    const r = await listStaff(getDb(), rc.actor, {
      q: u.get('q') ?? undefined,
      department: u.get('department') ?? undefined,
      status: status === 'active' || status === 'left' ? status : undefined,
      includeArchived: u.get('includeArchived') === 'true',
      limit: num('limit'),
      offset: num('offset'),
    })
    return r ? ok(r) : fail.forbidden('look up staff')
  },
})

export const POST = route({
  name: 'staff.create',
  access: { kind: 'action', action: 'staff_directory.manage' },
  body: createInput,
  handler: (rc, body) => createStaff(rc, body),
})
