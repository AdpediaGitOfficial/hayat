import { route } from '@/server/http'
import { fail } from '@/server/command/result'
import { revokeDelegation } from '@/server/commands/approvals/delegation'
import { idParam } from '@/server/queries/property/respond'

export const dynamic = 'force-dynamic'

export const POST = route({
  name: 'approvals.delegation.revoke',
  method: 'POST',
  access: { kind: 'authenticated' },
  handler: (rc, _b, _req, _r, { params }) => {
    const delegationId = idParam(params)
    return delegationId ? revokeDelegation(rc, { delegationId }) : Promise.resolve(fail.notFound())
  },
})
