import Link from 'next/link'
import { requirePage } from '@/server/auth/page'
import { decide } from '@/server/policy'
import { NAV } from '@/app-nav'
import { ROLE_LABEL, CAP_LABEL } from '@/domain/labels'
import { Badge, GlassCard, Icon, PageHeader } from '@/ui'

export default async function Home() {
  const cur = await requirePage()
  const { actor } = cur.rc
  const entries = NAV.filter(n => n.id !== 'home' && (!n.actions || n.actions.some(a => decide(actor, a).allowed)))
  return (
    <>
      <PageHeader eyebrow={ROLE_LABEL[actor.role]} title={`Welcome, ${cur.displayName}`} summary="You are signed in. What you can open depends on the role you are acting as." />
      <div className="grid even">
        <GlassCard title="You are acting as" subtitle="Switch role from the top bar if you hold more than one">
          <dl className="kv">
            <dt>Role</dt><dd>{ROLE_LABEL[actor.role]}</dd>
            <dt>Sites</dt><dd>{actor.sites === 'all' ? 'All sites' : actor.sites.length === 0 ? 'No site scope (own record or assigned jobs only)' : `${actor.sites.length} assigned`}</dd>
            <dt>Extra capabilities</dt><dd>{actor.caps.length ? <span className="chips">{actor.caps.map(c => <Badge key={c} tone="brand" dot={false}>{CAP_LABEL[c]}</Badge>)}</span> : 'None'}</dd>
          </dl>
        </GlassCard>
        <GlassCard title="Open a module" subtitle="Only the ones your role may use">
          {entries.length === 0 ? <div className="tbl-empty">Nothing is available to this role yet.</div> : (
            <div className="module-grid">
              {entries.map(n => (
                <Link key={n.id} href={n.href} className="card action-item"><span className="ai-chip brand"><Icon name={n.icon} /></span><span className="ai-main"><b>{n.label}</b></span></Link>
              ))}
            </div>
          )}
        </GlassCard>
      </div>
    </>
  )
}
