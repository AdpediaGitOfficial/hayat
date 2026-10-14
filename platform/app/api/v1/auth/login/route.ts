import { z } from 'zod'
import { route } from '@/server/http'
import { login } from '@/server/auth/login'
import { sessionCookie } from '@/server/auth/session'
import { getClock } from '@/server/runtime'
import { clientIp } from '@/server/http'
import { ok } from '@/server/command/result'

export const dynamic = 'force-dynamic'

export const POST = route({
  name: 'auth.login',
  access: { kind: 'public' },
  body: z.object({ username: z.string().trim().min(1, 'Enter your username').max(100), password: z.string().min(1, 'Enter your password').max(200) }),
  handler: async (_rc, body, req, reply) => {
    const r = await login({ ...body, ip: clientIp(req), userAgent: req.headers.get('user-agent') ?? undefined, requestId: req.headers.get('x-request-id') ?? crypto.randomUUID(), clock: getClock() })
    if (!r.ok) return r
    reply.cookies.push(sessionCookie(r.data.token, r.data.expiresAt))
    return ok({ role: r.data.role, modes: r.data.modes, mustChangePassword: r.data.mustChangePassword })
  },
})
