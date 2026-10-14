import { z } from 'zod'
import { route } from '@/server/http'
import { switchRole } from '@/server/auth/login'
import { ROLES } from '@/domain/enums'

export const dynamic = 'force-dynamic'

export const POST = route({
  name: 'auth.switch_role',
  access: { kind: 'authenticated' },
  body: z.object({ role: z.enum(ROLES) }),
  handler: (rc, body) => switchRole(rc, body.role),
})
