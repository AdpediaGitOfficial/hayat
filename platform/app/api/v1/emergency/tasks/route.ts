import { route } from '@/server/http'
import { getDb } from '@/server/db/client'
import { fail, ok } from '@/server/command/result'
import { mayUseEmergency } from '@/server/commands/emergency/rules'
import { listTasks } from '@/server/queries/emergency/tasks'

export const dynamic = 'force-dynamic'

/** Relocation and checkout tasks after rejected emergency check-ins, at the caller's sites. */
export const GET = route({
  name: 'emergency.tasks',
  access: { kind: 'authenticated' },
  handler: async (rc, _b, req) => {
    if (!mayUseEmergency(rc.actor)) return fail.forbidden('see emergency tasks')
    const open = new URL(req.url).searchParams.get('open')
    return ok(await listTasks(getDb(), rc.actor, rc.clock.now(), { open: open === 'false' ? false : open === 'true' ? true : undefined }))
  },
})
