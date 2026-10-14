import { route } from '@/server/http'
import { fail } from '@/server/command/result'
import { declineInput, declineTransferException } from '@/server/commands/stays/transferException'
import { idParam } from '@/server/queries/property/respond'

export const dynamic = 'force-dynamic'

/** A Policy Approver of the destination site declines the exception a transfer or swap needs, with a reason (P-10, proposed, pending client sign-off). */
export const POST = route({
  name: 'stays.transfer.exception.decline',
  access: { kind: 'action', action: 'requests_waitlist.approve_exception' },
  body: declineInput.omit({ transferId: true }),
  handler: (rc, body, _req, _r, { params }) => {
    const transferId = idParam(params)
    return transferId ? declineTransferException(rc, { ...body, transferId }) : Promise.resolve(fail.notFound())
  },
})
