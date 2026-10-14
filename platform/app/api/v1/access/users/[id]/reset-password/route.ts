import { route } from '@/server/http'
import { fail } from '@/server/command/result'
import { body, resetPassword } from '@/server/commands/access/reset-password'
import { pathId } from '@/server/queries/access/params'

export const dynamic = 'force-dynamic'

/** Admin-assisted reset. The new temporary password is in this response only. */
export const POST = route({
  name: 'access.users.reset_password',
  access: { kind: 'action', action: 'users_roles.manage_staff_accounts' },
  body,
  handler: async (rc, b, _req, _reply, { params }) => {
    const userId = pathId(params)
    return userId ? resetPassword(rc, { ...b, userId }) : fail.notFound()
  },
})
