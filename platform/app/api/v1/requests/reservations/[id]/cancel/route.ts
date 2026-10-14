import { route } from '@/server/http'
import { fail } from '@/server/command/result'
import { cancelReservation, reservationActionInput } from '@/server/commands/allocation-admin/reservations'
import { idParam } from '@/server/queries/property/respond'

export const dynamic = 'force-dynamic'

/** Cancel a reservation (AA, reason required). The bed claim is released in the same step. */
export const POST = route({
  name: 'reservations.cancel',
  access: { kind: 'action', action: 'reservations_stays.manage' },
  body: reservationActionInput.omit({ reservationId: true }),
  handler: (rc, body, _req, _r, { params }) => {
    const reservationId = idParam(params)
    return reservationId ? cancelReservation(rc, { ...body, reservationId }) : Promise.resolve(fail.notFound())
  },
})
