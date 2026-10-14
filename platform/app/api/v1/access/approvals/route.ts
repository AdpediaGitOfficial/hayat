import { route } from '@/server/http'
import { ok } from '@/server/command/result'
import { listPendingApprovals } from '@/server/queries/access/approvals'

export const dynamic = 'force-dynamic'

/** The checker's inbox: role changes and capability grants waiting for a second Super Admin. */
export const GET = route({
  name: 'access.approvals.list',
  access: { kind: 'action', action: 'users_roles.approve_grant' },
  handler: async rc => ok(await listPendingApprovals(rc.actor, rc.user.id)),
})
