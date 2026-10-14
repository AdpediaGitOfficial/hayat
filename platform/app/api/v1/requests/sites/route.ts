import { route } from '@/server/http'
import { getDb } from '@/server/db/client'
import { ok } from '@/server/command/result'
import { requestableSites } from '@/server/queries/requests/preview'

export const dynamic = 'force-dynamic'

/** The sites this actor may file a request for (a Resident: every live site; Reception and admins: their own). */
export const GET = route({
  name: 'requests.sites',
  access: { kind: 'action', action: 'requests_waitlist.submit' },
  handler: async rc => ok(await requestableSites(getDb(), rc.actor)),
})
