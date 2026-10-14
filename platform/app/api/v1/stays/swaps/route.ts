import { route } from '@/server/http'
import { requestSwap, swapInput } from '@/server/commands/stays/requestTransfer'

export const dynamic = 'force-dynamic'

/** An Accommodation Admin proposes that two residents exchange beds. Both must consent; it is executed as ONE atomic operation. */
export const POST = route({
  name: 'stays.swap.request',
  access: { kind: 'action', action: 'transfers_swaps.approve' },
  body: swapInput,
  handler: (rc, body) => requestSwap(rc, body),
})
