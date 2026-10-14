import { route } from '@/server/http'
import { fail, ok } from '@/server/command/result'
import { body, setConfig } from '@/server/commands/access/set-config'
import { getConfigHistory } from '@/server/queries/access/config'
import { configHistoryQuery, queryOf } from '@/server/queries/access/params'

export const dynamic = 'force-dynamic'

/** The version history of one setting (newest first). `?siteId=` for a per-site value. */
export const GET = route({
  name: 'access.config.history',
  access: { kind: 'action', action: 'system_config.view' },
  handler: async (rc, _b, req, _reply, { params }) => {
    const q = configHistoryQuery.safeParse(queryOf(req))
    if (!q.success) return fail.invalid('The site must be an id', { siteId: 'Not a valid site' })
    const h = await getConfigHistory(rc.actor, params.key ?? '', q.data.siteId)
    return h ? ok(h) : fail.notFound()
  },
})

/** Saves a new version (never edits an old one). A reason is required. */
export const PUT = route({
  name: 'access.config.set',
  method: 'PUT',
  access: { kind: 'action', action: 'system_config.manage' },
  body,
  handler: (rc, b, _req, _reply, { params }) => setConfig(rc, { ...b, key: params.key ?? '' }),
})
