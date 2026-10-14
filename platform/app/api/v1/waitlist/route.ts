import { route } from '@/server/http'
import { getDb } from '@/server/db/client'
import { ok } from '@/server/command/result'
import { addToWaitlist, input as addInput } from '@/server/commands/waitlist/add'
import { listQueues, myWaitlist, queueSites } from '@/server/queries/waitlist/queue'
import { isUuid } from '@/server/commands/property/shared'

export const dynamic = 'force-dynamic'

/**
 * The waitlist. Staff get the live queue of each site they may see (position, priority, expiry, offers in flight, ?siteId=
 * narrows it); a resident gets only their own entry and offers. Scope is applied in SQL.
 */
export const GET = route({
  name: 'waitlist.list',
  access: { kind: 'action', action: 'requests_waitlist.view' },
  handler: async (rc, _b, req) => {
    const siteId = new URL(req.url).searchParams.get('siteId') ?? undefined
    const db = getDb()
    const scope = queueSites(rc.actor)
    if (scope === 'all' || scope.length > 0) return ok({ kind: 'staff' as const, queues: await listQueues(db, rc.actor, { siteId: siteId && isUuid(siteId) ? siteId : undefined }) })
    return ok({ kind: 'own' as const, ...(rc.actor.staffId ? await myWaitlist(db, rc.actor.staffId, rc.clock.now()) : { entry: null, offer: null, lastEnded: null }) })
  },
})

/** Adds a person to the waitlist: a resident for themselves, Reception/AA/SA for someone else. WP-D calls this when no bed matches a request. */
export const POST = route({
  name: 'waitlist.add',
  access: { kind: 'action', action: 'requests_waitlist.submit' },
  body: addInput,
  handler: (rc, body) => addToWaitlist(rc, body),
})
