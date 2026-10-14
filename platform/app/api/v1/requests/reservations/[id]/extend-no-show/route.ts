import { route } from '@/server/http'
import { fail } from '@/server/command/result'
import { extendNoShow, reservationActionInput } from '@/server/commands/allocation-admin/reservations'
import { idParam } from '@/server/queries/property/respond'

export const dynamic = 'force-dynamic'

/** Extend the no-show deadline once, with a reason (D-58). */
export const POST = route({
  name: 'reservations.extend_no_show',
  access: { kind: 'action', action: 'reservations_stays.manage' },
  body: reservationActionInput.omit({ reservationId: true }),
  handler: (rc, body, _req, _r, { params }) => {
    const reservationId = idParam(params)
    return reservationId ? extendNoShow(rc, { ...body, reservationId }) : Promise.resolve(fail.notFound())
  },
})
