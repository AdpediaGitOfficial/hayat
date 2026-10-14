import { route } from '@/server/http'
import { getDb } from '@/server/db/client'
import { ok } from '@/server/command/result'
import { createDelegation, createInput } from '@/server/commands/approvals/delegation'
import { myDelegations } from '@/server/queries/requests/inbox'

export const dynamic = 'force-dynamic'

/**
 * Out-of-office delegation. The guard is "signed in": whether the person is an approver (and whether the stand-in is) is
 * decided in the command from their roles, since "approver" is several policy actions. A delegation adds no authority (S-13).
 */
export const GET = route({
  name: 'approvals.delegations',
  access: { kind: 'authenticated' },
  handler: async rc => ok(await myDelegations(getDb(), rc.user.id, rc.clock.now())),
})

export const POST = route({
  name: 'approvals.delegation.create',
  access: { kind: 'authenticated' },
  body: createInput,
  handler: (rc, body) => createDelegation(rc, body),
})
