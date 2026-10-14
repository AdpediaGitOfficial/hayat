import { route } from '@/server/http'
import { fail } from '@/server/command/result'
import { viewStaff } from '@/server/commands/staff/read'

export const dynamic = 'force-dynamic'

/** The signed-in person's own staff record, in the shape their active role allows. */
export const GET = route({
  name: 'staff.me',
  access: { kind: 'authenticated' },
  handler: (rc) => (rc.user.staffId ? viewStaff(rc, rc.user.staffId) : Promise.resolve(fail.notFound())),
})
