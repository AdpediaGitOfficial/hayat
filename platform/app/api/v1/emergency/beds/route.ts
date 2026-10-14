import { route } from '@/server/http'
import { getDb } from '@/server/db/client'
import { ok } from '@/server/command/result'
import { freeBeds } from '@/server/queries/emergency/pick'

export const dynamic = 'force-dynamic'

/** Beds the initiator may use now: Available, in their own sites, with nothing booked over today. */
export const GET = route({
  name: 'emergency.beds',
  access: { kind: 'action', action: 'emergency_checkin.initiate' },
  handler: async (rc, _b, req) => {
    const q = new URL(req.url).searchParams
    const siteId = q.get('siteId')
    return ok(await freeBeds(getDb(), rc.actor, rc.clock.now().toISOString().slice(0, 10), {
      siteId: siteId && /^[0-9a-f-]{36}$/i.test(siteId) ? siteId : undefined, q: q.get('q') ?? undefined,
    }))
  },
})
