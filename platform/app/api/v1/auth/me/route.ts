import { route } from '@/server/http'
import { currentUser } from '@/server/auth/current'
import { readCookie } from '@/server/auth/session'
import { ok } from '@/server/command/result'

export const dynamic = 'force-dynamic'

export const GET = route({
  name: 'auth.me',
  access: { kind: 'authenticated', allowMustChange: true },
  handler: async (rc, _b, req) => {
    const cur = await currentUser(readCookie(req.headers.get('cookie')), { clock: rc.clock, requestId: rc.requestId, ip: rc.ip })
    if ('ok' in cur) return cur
    const { actor, user } = cur.rc
    return ok({
      username: user.username, role: actor.role, modes: cur.modes, capabilities: actor.caps,
      sites: actor.sites, mustChangePassword: cur.mustChangePassword,
    })
  },
})
