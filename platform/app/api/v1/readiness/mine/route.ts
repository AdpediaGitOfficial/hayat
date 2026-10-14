import { route } from '@/server/http'
import { fail, ok } from '@/server/command/result'
import { getDb } from '@/server/db/client'
import { myRooms } from '@/server/queries/readiness/mine'

export const dynamic = 'force-dynamic'

/** The actor's own open cleaning tasks (job scope: assigned to them, nothing else) and the checklist to answer. */
export const GET = route({
  name: 'readiness.mine',
  access: { kind: 'action', action: 'housekeeping_readiness.clean' },
  handler: async rc => {
    const mine = await myRooms(getDb(), rc.actor)
    return mine ? ok(mine) : fail.forbidden('see housekeeping rooms without a staff record')
  },
})
