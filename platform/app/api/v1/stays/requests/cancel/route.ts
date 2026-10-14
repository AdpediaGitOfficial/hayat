import { route } from '@/server/http'
import { cancelRequest, input } from '@/server/commands/stays/cancel'

export const dynamic = 'force-dynamic'

/** Withdraw a transfer, extension or checkout request that has not been carried out. Nothing about the stay changes. */
export const POST = route({
  name: 'stays.request.cancel',
  access: { kind: 'action', action: 'reservations_stays.view' },
  body: input,
  handler: (rc, body) => cancelRequest(rc, body),
})
