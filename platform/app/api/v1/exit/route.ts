import { route } from '@/server/http'
import { getDb } from '@/server/db/client'
import { ok } from '@/server/command/result'
import { markLeft, markLeftInput } from '@/server/commands/exit/markLeft'
import { listCases } from '@/server/queries/exit/cases'

export const dynamic = 'force-dynamic'

/** Clearance cases the caller may see: open first, overdue marked. Out-of-scope cases are simply not in the list. */
export const GET = route({
  name: 'exit.list',
  access: { kind: 'action', action: 'exit_clearance.view' },
  handler: async (rc, _b, req) => {
    const q = new URL(req.url).searchParams
    const scope = q.get('scope')
    return ok(await listCases(getDb(), rc.actor, {
      q: q.get('q') ?? undefined, scope: scope === 'cleared' || scope === 'all' ? scope : 'open', overdueOnly: q.get('overdue') === '1', now: rc.clock.now(),
    }))
  },
})

/** Mark as Left: login and every session end now, a clearance case opens, the stay and the bed are NOT touched (D-35). Re-confirms the password. */
export const POST = route({
  name: 'exit.mark_left',
  access: { kind: 'action', action: 'exit_clearance.mark_left' },
  body: markLeftInput,
  handler: (rc, body) => markLeft(rc, body),
})
