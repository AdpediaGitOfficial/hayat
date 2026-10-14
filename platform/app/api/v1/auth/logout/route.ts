import { route } from '@/server/http'
import { logout } from '@/server/auth/login'
import { clearedCookie } from '@/server/auth/session'

export const dynamic = 'force-dynamic'

export const POST = route({
  name: 'auth.logout',
  method: 'POST',
  access: { kind: 'authenticated', allowMustChange: true },
  handler: async (rc, _b, _req, reply) => {
    const r = await logout(rc)
    reply.cookies.push(clearedCookie())
    return r
  },
})
