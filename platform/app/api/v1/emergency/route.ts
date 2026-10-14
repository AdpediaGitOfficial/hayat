import { route } from '@/server/http'
import { getDb } from '@/server/db/client'
import { fail, ok } from '@/server/command/result'
import { initiateEmergency, input as initiateInput } from '@/server/commands/emergency/initiate'
import { mayUseEmergency } from '@/server/commands/emergency/rules'
import { listCases } from '@/server/queries/emergency/cases'

export const dynamic = 'force-dynamic'

/** Emergency check-ins the caller may see: those at their sites (view or approve), and the ones they started themselves. */
export const GET = route({
  name: 'emergency.list',
  access: { kind: 'authenticated' },
  handler: async (rc, _b, req) => {
    if (!mayUseEmergency(rc.actor)) return fail.forbidden('see emergency check-ins')
    const q = new URL(req.url).searchParams
    const status = q.get('status')
    const siteId = q.get('siteId')
    return ok(await listCases(getDb(), { actor: rc.actor, userId: rc.user.id }, {
      status: status === 'pending' || status === 'decided' ? status : 'all',
      siteId: siteId && /^[0-9a-f-]{36}$/i.test(siteId) ? siteId : undefined,
    }))
  },
})

/** Start an emergency check-in: a provisional stay in a bed now, and an approval case. Emergency Check-in capability holders only (D-66). */
export const POST = route({
  name: 'emergency.initiate',
  access: { kind: 'action', action: 'emergency_checkin.initiate' },
  body: initiateInput,
  handler: (rc, body) => initiateEmergency(rc, body),
})
