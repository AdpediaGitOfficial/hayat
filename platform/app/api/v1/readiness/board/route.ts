import { route } from '@/server/http'
import { fail, ok } from '@/server/command/result'
import { getDb } from '@/server/db/client'
import { readinessBoard } from '@/server/queries/readiness/board'

export const dynamic = 'force-dynamic'

/**
 * The readiness board of the actor's sites. A housekeeper (job scope only) gets 403: their rooms are at /readiness/mine.
 * The Manager and the Auditor get the summary without rows or names.
 */
export const GET = route({
  name: 'readiness.board',
  access: { kind: 'action', action: 'housekeeping_readiness.view' },
  handler: async (rc, _b, req) => {
    const siteId = new URL(req.url).searchParams.get('siteId') ?? undefined
    const board = await readinessBoard(getDb(), rc.actor, rc.clock.now(), { siteId: siteId && /^[0-9a-f-]{36}$/i.test(siteId) ? siteId : undefined })
    return board ? ok(board) : fail.forbidden('see the readiness board (you see your own rooms instead)', 'Reception')
  },
})
