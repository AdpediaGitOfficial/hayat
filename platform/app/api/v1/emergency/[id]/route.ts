import { route } from '@/server/http'
import { getDb } from '@/server/db/client'
import { fail, ok } from '@/server/command/result'
import { mayUseEmergency } from '@/server/commands/emergency/rules'
import { getCase } from '@/server/queries/emergency/cases'
import { idParam } from '@/server/queries/property/respond'

export const dynamic = 'force-dynamic'

/** One emergency check-in. Out of scope reads exactly like a case that does not exist. */
export const GET = route({
  name: 'emergency.get',
  access: { kind: 'authenticated' },
  handler: async (rc, _b, _req, _r, { params }) => {
    if (!mayUseEmergency(rc.actor)) return fail.forbidden('see emergency check-ins')
    const id = idParam(params)
    const r = id ? await getCase(getDb(), { actor: rc.actor, userId: rc.user.id }, id) : undefined
    return r ? ok(r) : fail.notFound()
  },
})
