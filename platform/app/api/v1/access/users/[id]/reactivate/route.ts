import { route } from '@/server/http'
import { fail } from '@/server/command/result'
import { body, reactivateAccount } from '@/server/commands/access/reactivate-account'
import { pathId } from '@/server/queries/access/params'

export const dynamic = 'force-dynamic'

/** Reactivation issues a NEW temporary password, in this response only. */
export const POST = route({
  name: 'access.users.reactivate',
  access: { kind: 'action', action: 'users_roles.manage_staff_accounts' },
  body,
  handler: async (rc, b, _req, _reply, { params }) => {
    const userId = pathId(params)
    return userId ? reactivateAccount(rc, { ...b, userId }) : fail.notFound()
  },
})
