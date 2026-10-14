import { route } from '@/server/http'
import { ok } from '@/server/command/result'
import { listConfig } from '@/server/queries/access/config'

export const dynamic = 'force-dynamic'

/** Every registry setting with its current value, default, decision reference and status. */
export const GET = route({
  name: 'access.config.list',
  access: { kind: 'action', action: 'system_config.view' },
  handler: async rc => ok(await listConfig(rc.actor)),
})
