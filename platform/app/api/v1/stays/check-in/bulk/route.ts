import { route } from '@/server/http'
import { bulkCheckIn, bulkInput } from '@/server/commands/stays/checkIn'

export const dynamic = 'force-dynamic'

/** Batch arrivals (D-60): each row is its own transaction; the answer is per row and a retry is safe. */
export const POST = route({
  name: 'stays.check_in_bulk',
  access: { kind: 'action', action: 'checkin_checkout.execute' },
  body: bulkInput,
  handler: (rc, body) => bulkCheckIn(rc, body),
})
