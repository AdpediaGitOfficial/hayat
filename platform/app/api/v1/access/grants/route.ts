import { route } from '@/server/http'
import { input, requestGrant } from '@/server/commands/access/request-grant'

export const dynamic = 'force-dynamic'

/** Maker step for a capability grant (reason required, optional start and expiry). A different Super Admin decides. */
export const POST = route({
  name: 'access.grants.request',
  access: { kind: 'action', action: 'users_roles.manage_roles_and_scope' },
  body: input,
  reauth: { action: 'access.grant' },
  handler: (rc, body) => requestGrant(rc, body),
})
