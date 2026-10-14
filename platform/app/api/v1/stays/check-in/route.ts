import { route } from '@/server/http'
import { checkIn, input } from '@/server/commands/stays/checkIn'

export const dynamic = 'force-dynamic'

/** Check a reserved resident in: stay, claim and bed occupancy in one transaction (D-59). */
export const POST = route({
  name: 'stays.check_in',
  access: { kind: 'action', action: 'checkin_checkout.execute' },
  body: input,
  handler: (rc, body) => checkIn(rc, body),
})
