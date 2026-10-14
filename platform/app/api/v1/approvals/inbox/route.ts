import { route } from '@/server/http'
import { getDb } from '@/server/db/client'
import { ok } from '@/server/command/result'
import { approvalsInbox } from '@/server/queries/requests/inbox'

export const dynamic = 'force-dynamic'

/** Everything waiting for a decision that the actor may see, with route, current approver, SLA clock and "why you can't approve". */
export const GET = route({
  name: 'approvals.inbox',
  access: { kind: 'action', action: 'approvals_inbox.view' },
  handler: async rc => ok(await approvalsInbox(getDb(), rc)),
})
