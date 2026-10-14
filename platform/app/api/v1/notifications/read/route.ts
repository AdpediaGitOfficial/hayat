import { z } from 'zod'
import { route } from '@/server/http'
import { markRead } from '@/server/notify/read'

export const dynamic = 'force-dynamic'

/** Marks the given notifications (or all visible ones) read for this actor. Only ones the actor may see are touched. */
export const POST = route({
  name: 'notifications.read',
  access: { kind: 'authenticated' },
  body: z.object({ ids: z.array(z.string().uuid()).max(200).optional() }).default({}),
  handler: (rc, body) => markRead(rc, body.ids),
})
