import { route } from '@/server/http'
import { getDb } from '@/server/db/client'
import { listNotifications, unreadCount } from '@/server/notify'
import { ok } from '@/server/command/result'

export const dynamic = 'force-dynamic'

export const GET = route({
  name: 'notifications.list',
  access: { kind: 'authenticated' },
  handler: async rc => ok({
    unread: await unreadCount(getDb(), rc.actor),
    items: (await listNotifications(getDb(), rc.actor, { limit: 50 })).map(n => ({
      id: n.id, kind: n.kind, text: n.text, refType: n.refType, refId: n.refId, critical: n.critical, read: !!n.readAt, at: n.createdAt,
    })),
  }),
})
