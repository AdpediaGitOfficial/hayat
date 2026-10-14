import { route } from '@/server/http'
import { archiveStaff, input } from '@/server/commands/staff/archive'

export const dynamic = 'force-dynamic'

export const POST = route({
  name: 'staff.archive',
  access: { kind: 'action', action: 'staff_directory.manage' },
  body: input.omit({ id: true }),
  handler: (rc, body, _req, _reply, { params }) => archiveStaff(rc, { ...body, id: params.id }),
})
