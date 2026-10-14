import { route } from '@/server/http'
import { ok } from '@/server/command/result'
import { getDb } from '@/server/db/client'
import { inspectionQueue } from '@/server/queries/readiness/inspections'

export const dynamic = 'force-dynamic'

/** Cleaned rooms waiting for their final inspection, at the sites of a Final Inspection holder. */
export const GET = route({
  name: 'readiness.inspections',
  access: { kind: 'action', action: 'housekeeping_readiness.final_inspection' },
  handler: async rc => ok(await inspectionQueue(getDb(), rc.actor)),
})
