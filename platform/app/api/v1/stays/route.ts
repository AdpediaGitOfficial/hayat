import { route } from '@/server/http'
import { ok } from '@/server/command/result'
import { listStays } from '@/server/queries/stays/stays'

export const dynamic = 'force-dynamic'

/** Stays the actor may see (their sites, or only their own for a resident), with the ending / overdue flag. */
export const GET = route({
  name: 'stays.list',
  access: { kind: 'action', action: 'reservations_stays.view' },
  handler: async (rc, _b, req) => {
    const u = new URL(req.url).searchParams
    const num = (k: string) => (u.has(k) && u.get(k) !== '' ? Number(u.get(k)) : undefined)
    const flag = u.get('flag')
    return ok(await listStays(rc.actor, {
      siteId: u.get('siteId') ?? undefined, status: u.get('status') ?? undefined,
      flag: flag === 'overdue' || flag === 'ending' || flag === 'attention' ? flag : undefined, limit: num('limit'), offset: num('offset'),
    }))
  },
})
