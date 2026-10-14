import { route } from '@/server/http'
import { fail } from '@/server/command/result'
import { decideBody, decideGrant } from '@/server/commands/access/decide-grant'
import { pathId } from '@/server/queries/access/params'

export const dynamic = 'force-dynamic'

export const POST = route({
  name: 'access.grants.decide',
  access: { kind: 'action', action: 'users_roles.approve_grant' },
  body: decideBody,
  handler: async (rc, b, _req, _reply, { params }) => {
    const grantId = pathId(params)
    return grantId ? decideGrant(rc, { ...b, grantId }) : fail.notFound()
  },
})
