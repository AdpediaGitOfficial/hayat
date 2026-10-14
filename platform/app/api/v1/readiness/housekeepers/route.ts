import { route } from '@/server/http'
import { fail, ok } from '@/server/command/result'
import { getDb } from '@/server/db/client'
import { listHousekeepers } from '@/server/queries/readiness/housekeepers'

export const dynamic = 'force-dynamic'

/** People who can be given a cleaning task (active Housekeeping grant). Optional ?taskId= marks those who live in that room. */
export const GET = route({
  name: 'readiness.housekeepers',
  access: { kind: 'action', action: 'housekeeping_readiness.assign' },
  handler: async (rc, _b, req) => {
    const taskId = new URL(req.url).searchParams.get('taskId') ?? undefined
    if (taskId && !/^[0-9a-f-]{36}$/i.test(taskId)) return fail.notFound()
    const list = await listHousekeepers(getDb(), rc.actor, rc.clock.now(), { taskId })
    return list ? ok(list) : fail.notFound()
  },
})
