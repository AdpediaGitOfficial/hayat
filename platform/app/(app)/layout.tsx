import type { ReactNode } from 'react'
import { requirePage } from '@/server/auth/page'
import { decide } from '@/server/policy'
import { NAV } from '@/app-nav'
import { AppShell } from '@/ui/shell/AppShell'
import { CAP_LABEL } from '@/domain/labels'
import { getDb } from '@/server/db/client'
import { unreadCount } from '@/server/notify'

export const dynamic = 'force-dynamic'

export default async function AppLayout({ children }: { children: ReactNode }) {
  const cur = await requirePage()
  const { actor } = cur.rc
  const nav = NAV
    .filter(n => !n.actions || n.actions.some(a => decide(actor, a).allowed))
    .map(({ id, label, href, icon, group }) => ({ id, label, href, icon, group }))
  const unread = await unreadCount(getDb(), actor)
  return (
    <AppShell
      user={{ name: cur.displayName, role: actor.role, modes: cur.modes, capabilityLabels: actor.caps.map(c => CAP_LABEL[c]) }}
      nav={nav}
      unread={unread}
    >
      {children}
    </AppShell>
  )
}
