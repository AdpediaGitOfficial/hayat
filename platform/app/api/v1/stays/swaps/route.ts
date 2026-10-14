import { route } from '@/server/http'
import { requestSwap, swapInput } from '@/server/commands/stays/requestTransfer'

export const dynamic = 'force-dynamic'

/**
 * An Accommodation Admin proposes that two residents exchange beds (Reception too, only while `transfers.reception_may_raise` is on: P-09,
 * proposed, pending client sign-off). Both must consent; it is executed as ONE atomic operation. The guard is "may view transfers"; the
 * command decides who may raise one (a resident, a Manager or an Auditor is refused there with the reason).
 */
export const POST = route({
  name: 'stays.swap.request',
  access: { kind: 'action', action: 'transfers_swaps.view' },
  body: swapInput,
  handler: (rc, body) => requestSwap(rc, body),
})
