import { route } from '@/server/http'
import { fail } from '@/server/command/result'
import { body, decideRoleChange } from '@/server/commands/access/decide-role-change'
import { pathId } from '@/server/queries/access/params'

export const dynamic = 'force-dynamic'

/** Checker step (D-27): a different Super Admin approves (and the change is applied) or rejects. */
export const POST = route({
  name: 'access.role_changes.decide',
  access: { kind: 'action', action: 'users_roles.manage_roles_and_scope' },
  body,
  handler: async (rc, b, _req, _reply, { params }) => {
    const requestId = pathId(params)
    return requestId ? decideRoleChange(rc, { ...b, requestId }) : fail.notFound()
  },
})
