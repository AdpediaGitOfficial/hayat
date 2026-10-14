import { z } from 'zod'
import { route } from '@/server/http'
import { changePassword } from '@/server/auth/login'

export const dynamic = 'force-dynamic'

export const POST = route({
  name: 'auth.change_password',
  access: { kind: 'authenticated', allowMustChange: true },
  body: z.object({ current: z.string().min(1, 'Enter your current password').max(200), next: z.string().min(1, 'Enter a new password').max(200) }),
  handler: (rc, body) => changePassword(rc, body),
})
