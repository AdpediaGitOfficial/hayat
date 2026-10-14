import { route } from '@/server/http'
import { getDb } from '@/server/db/client'
import { fail, ok } from '@/server/command/result'
import { RESERVATION_STATUSES, type ReservationStatus } from '@/domain/enums'
import { isUuid } from '@/server/commands/property/shared'
import { listReservations } from '@/server/queries/requests/reservations'

export const dynamic = 'force-dynamic'

export const GET = route({
  name: 'reservations.list',
  access: { kind: 'action', action: 'reservations_stays.view' },
  handler: async (rc, _b, req) => {
    const u = new URL(req.url).searchParams
    const status = u.get('status') ?? ''
    if (status && !(RESERVATION_STATUSES as readonly string[]).includes(status)) return fail.invalid('Unknown status', { status: 'Not a reservation status' })
    const siteId = u.get('siteId') ?? ''
    if (siteId && !isUuid(siteId)) return fail.invalid('Not a valid site', { siteId: 'Not a valid identifier' })
    const num = (k: string) => (u.get(k) ? Number(u.get(k)) : undefined)
    return ok(await listReservations(getDb(), rc.actor, { status: (status || undefined) as ReservationStatus | undefined, siteId: siteId || undefined, q: u.get('q') ?? undefined, limit: num('limit'), offset: num('offset') }))
  },
})
