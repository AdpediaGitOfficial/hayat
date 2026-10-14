import { route } from '@/server/http'
import { fail } from '@/server/command/result'
import { body, requestRoleChange } from '@/server/commands/access/request-role-change'
import { pathId } from '@/server/queries/access/params'

export const dynamic = 'force-dynamic'

/** Maker step (D-27): files a role or scope change. Nothing changes until a different Super Admin approves it. */
export const POST = route({
  name: 'access.role_changes.request',
  access: { kind: 'action', action: 'users_roles.manage_roles_and_scope' },
  body,
  handler: async (rc, b, _req, _reply, { params }) => {
    const userId = pathId(params)
    return userId ? requestRoleChange(rc, { ...b, userId }) : fail.notFound()
  },
})
