import { requirePage } from '@/server/auth/page'
import { getDb } from '@/server/db/client'
import { listNotifications } from '@/server/notify'
import { Badge, GlassCard, PageHeader } from '@/ui'
import { MarkAllRead } from './MarkAllRead'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Notifications · Grand Hyatt Staff Accommodation' }

export default async function Notifications() {
  const cur = await requirePage()
  const items = await listNotifications(getDb(), cur.rc.actor, { limit: 100 })
  const unread = items.filter(n => !n.readAt).length
  return (
    <>
      <PageHeader eyebrow="In-app and email" title="Notifications" summary={unread ? `${unread} unread` : 'You are all caught up'} actions={unread ? <MarkAllRead /> : undefined} />
      <GlassCard flush>
        {items.length === 0 ? <div className="tbl-empty">Nothing yet.</div> : (
          <ul className="list-plain" style={{ padding: '0 20px' }}>
            {items.map(n => (
              <li key={n.id}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: n.readAt ? 400 : 600 }}>{n.text}</div>
                  <div className="subtle body-sm">{n.createdAt.toISOString().slice(0, 16).replace('T', ' ')} UTC{n.emailStatus === 'failed' ? ' · email not delivered' : ''}</div>
                </div>
                {n.critical && <Badge tone="danger">Critical</Badge>}
                {!n.readAt && <Badge tone="brand" dot>New</Badge>}
              </li>
            ))}
          </ul>
        )}
      </GlassCard>
    </>
  )
}
