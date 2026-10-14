import { route } from '@/server/http'
import { fail } from '@/server/command/result'
import { body, revokeGrant } from '@/server/commands/access/revoke-grant'
import { pathId } from '@/server/queries/access/params'

export const dynamic = 'force-dynamic'

/** Takes a capability away at once, or withdraws a request still waiting. */
export const POST = route({
  name: 'access.grants.revoke',
  access: { kind: 'action', action: 'users_roles.approve_grant' },
  body,
  reauth: { action: 'access.grant' },
  handler: async (rc, b, _req, _reply, { params }) => {
    const grantId = pathId(params)
    return grantId ? revokeGrant(rc, { ...b, grantId }) : fail.notFound()
  },
})
