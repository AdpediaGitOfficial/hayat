import { route } from '@/server/http'
import { fail } from '@/server/command/result'
import { body, deactivateAccount } from '@/server/commands/access/deactivate-account'
import { pathId } from '@/server/queries/access/params'

export const dynamic = 'force-dynamic'

export const POST = route({
  name: 'access.users.deactivate',
  access: { kind: 'action', action: 'users_roles.manage_staff_accounts' },
  body,
  handler: async (rc, b, _req, _reply, { params }) => {
    const userId = pathId(params)
    return userId ? deactivateAccount(rc, { ...b, userId }) : fail.notFound()
  },
})
