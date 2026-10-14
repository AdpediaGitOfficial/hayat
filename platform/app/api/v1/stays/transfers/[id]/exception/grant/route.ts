import { route } from '@/server/http'
import { fail } from '@/server/command/result'
import { grantInput, grantTransferException } from '@/server/commands/stays/transferException'
import { idParam } from '@/server/queries/property/respond'

export const dynamic = 'force-dynamic'

/**
 * A Policy Approver of the DESTINATION site grants a gender or grade exception for this one transfer or swap (S-21, P-10: proposed,
 * pending client sign-off; the command refuses it while `transfers.exception_path` is off). Reason and evidence are required, the
 * approver's password is re-confirmed in the command, and never the person moving nor whoever raised the move.
 */
export const POST = route({
  name: 'stays.transfer.exception.grant',
  access: { kind: 'action', action: 'requests_waitlist.approve_exception' },
  body: grantInput.omit({ transferId: true }),
  handler: (rc, body, _req, _r, { params }) => {
    const transferId = idParam(params)
    return transferId ? grantTransferException(rc, { ...body, transferId }) : Promise.resolve(fail.notFound())
  },
})
