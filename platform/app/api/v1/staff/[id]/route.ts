import { route } from '@/server/http'
import { viewStaff } from '@/server/commands/staff/read'
import { updateStaff, input as updateInput } from '@/server/commands/staff/update'

export const dynamic = 'force-dynamic'

/** One staff record in the acting role's shape. Anything the role may not see is a plain 404, never a 403 (AT-001). */
export const GET = route({
  name: 'staff.get',
  access: { kind: 'authenticated' },
  handler: (rc, _b, _req, _reply, { params }) => viewStaff(rc, params.id),
})

export const PATCH = route({
  name: 'staff.update',
  method: 'PATCH',
  access: { kind: 'action', action: 'staff_directory.manage' },
  body: updateInput.omit({ id: true }),
  handler: (rc, body, _req, _reply, { params }) => updateStaff(rc, { ...body, id: params.id }),
})
