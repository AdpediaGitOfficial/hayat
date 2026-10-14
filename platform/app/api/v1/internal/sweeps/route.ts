import { z } from 'zod'
import { route } from '@/server/http'
import { listSweeps, runSweeps } from '@/server/jobs/registry'
import '@/server/jobs/sweeps'
import { getClock } from '@/server/runtime'
import { ok } from '@/server/command/result'

export const dynamic = 'force-dynamic'

/** Scheduler entry point: POST every minute or so. Sweeps are idempotent and never decide for a person. */
export const POST = route({
  name: 'internal.sweeps',
  access: { kind: 'internal' },
  body: z.object({ only: z.array(z.string()).optional() }).default({}),
  handler: async (_rc, body) => ok({ available: listSweeps().map(s => s.name), outcomes: await runSweeps(getClock(), body.only) }),
})
