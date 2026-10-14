import { route } from '@/server/http'
import { fail } from '@/server/command/result'
import { body, revokeUserSessions } from '@/server/commands/access/revoke-sessions'
import { pathId } from '@/server/queries/access/params'

export const dynamic = 'force-dynamic'

export const POST = route({
  name: 'access.users.revoke_sessions',
  access: { kind: 'action', action: 'users_roles.manage_staff_accounts' },
  body,
  handler: async (rc, b, _req, _reply, { params }) => {
    const userId = pathId(params)
    return userId ? revokeUserSessions(rc, { ...b, userId }) : fail.notFound()
  },
})
