import { route } from '@/server/http'
import { ok } from '@/server/command/result'
import { listArrivals } from '@/server/queries/stays/arrivals'

export const dynamic = 'force-dynamic'

/** Today's and expected arrivals with a "not ready" marker, reason, owner and next action when the bed would refuse check-in. */
export const GET = route({
  name: 'stays.arrivals',
  access: { kind: 'action', action: 'checkin_checkout.view' },
  handler: async (rc, _b, req) => {
    const u = new URL(req.url).searchParams
    const days = u.get('days') ? Number(u.get('days')) : undefined
    return ok(await listArrivals(rc.actor, { siteId: u.get('siteId') ?? undefined, horizonDays: days !== undefined && days >= 0 && days <= 60 ? days : undefined }))
  },
})
