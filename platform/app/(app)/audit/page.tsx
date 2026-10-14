import { requirePage } from '@/server/auth/page'
import { searchAudit } from '@/server/queries/access/audit'
import { auditQuery, toAuditFilter } from '@/server/queries/access/params'
import { ROLE_LABEL } from '@/domain/labels'
import type { Role } from '@/domain/enums'
import { Alert, Badge, GlassCard, PageHeader } from '@/ui'
import { LinkButton } from '../users/link-button'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Audit log · Grand Hyatt Staff Accommodation' }

const json = (v: unknown) => JSON.stringify(v, null, 2)

export default async function AuditPage({ searchParams }: { searchParams: Record<string, string | string[] | undefined> }) {
  const cur = await requirePage('audit_log.view')
  const { actor } = cur.rc
  const flat = Object.fromEntries(Object.entries(searchParams).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v ?? '']))
  const parsed = auditQuery.safeParse(flat)
  const q = parsed.success ? parsed.data : auditQuery.parse({})
  const page = await searchAudit(actor, toAuditFilter(q))
  const keep = Object.fromEntries(Object.entries(flat).filter(([k, v]) => v && k !== 'before'))
  const older = page.nextBefore ? `/audit?${new URLSearchParams({ ...keep, before: String(page.nextBefore) }).toString()}` : undefined
  const bad = parsed.success ? {} : Object.fromEntries(parsed.error.issues.map(i => [String(i.path[0]), i.message]))

  return (
    <>
      <PageHeader crumbs={['System']} title="Audit log"
        summary="Every change, newest first. It is append-only: no screen, API or database role can edit or delete an entry." />
      {actor.sites !== 'all' && (
        <Alert tone="info" title="You see events recorded against your sites"
          detail="Events that belong to no site (sign-ins, capability grants, global settings) are visible to administrators and auditors with access to all sites." />
      )}
      {!parsed.success && <Alert tone="warning" title="Some filters were not understood" detail={Object.values(bad).join(' · ')} />}

      <GlassCard strong flush>
        <form method="get" className="tbl-tool" style={{ paddingTop: 16, flexWrap: 'wrap' }}>
          <input className="input" name="action" defaultValue={flat.action ?? ''} placeholder="Action starts with, e.g. access.grant" aria-label="Action prefix" style={{ maxWidth: 260 }} />
          <input className="input" name="entityType" defaultValue={flat.entityType ?? ''} placeholder="Entity type" aria-label="Entity type" style={{ maxWidth: 160 }} />
          <input className="input" name="entityId" defaultValue={flat.entityId ?? ''} placeholder="Entity id" aria-label="Entity id" style={{ maxWidth: 200 }} />
          <input className="input" name="actor" defaultValue={flat.actor ?? ''} placeholder="Actor (username)" aria-label="Actor" style={{ maxWidth: 170 }} />
          <input className="input" type="date" name="from" defaultValue={flat.from?.slice(0, 10) ?? ''} aria-label="From date" style={{ maxWidth: 160 }} />
          <input className="input" type="date" name="to" defaultValue={flat.to?.slice(0, 10) ?? ''} aria-label="To date" style={{ maxWidth: 160 }} />
          <button className="btn secondary" type="submit">Filter</button>
          {Object.keys(keep).length > 0 && <LinkButton variant="ghost" href="/audit">Clear</LinkButton>}
        </form>
        <div className="tbl-wrap">
          <table className="tbl stack-m">
            <thead><tr><th>When (UTC)</th><th>Who</th><th>What</th><th>Entity</th><th>Details</th></tr></thead>
            <tbody>
              {page.rows.map(e => (
                <tr key={e.id} data-testid="audit-row" data-action={e.action}>
                  <td data-h="When" className="tnum muted">{e.at.replace('T', ' ').slice(0, 19)}<div className="subtle body-sm">#{e.seq}</div></td>
                  <td data-h="Who">{e.actorUsername ?? <span className="subtle">System</span>}{e.actorRole && <div className="subtle body-sm">{ROLE_LABEL[e.actorRole as Role] ?? e.actorRole}</div>}</td>
                  <td data-h="What"><b className="mono" style={{ fontSize: 12.5 }}>{e.action}</b>{e.reason && <div className="body-sm">{e.reason}</div>}</td>
                  <td data-h="Entity" className="muted body-sm">{e.entityType ?? '—'}{e.siteCode && <> · <Badge outline>{e.siteCode}</Badge></>}{e.entityId && <div className="mono subtle" style={{ fontSize: 11 }}>{e.entityId}</div>}</td>
                  <td data-h="Details">
                    {e.before != null || e.after != null ? (
                      <details>
                        <summary className="body-sm">Before and after</summary>
                        {e.before != null && <><div className="eyebrow">Before</div><pre className="mono" style={{ fontSize: 11.5, whiteSpace: 'pre-wrap', margin: '4px 0 8px' }}>{json(e.before)}</pre></>}
                        {e.after != null && <><div className="eyebrow">After</div><pre className="mono" style={{ fontSize: 11.5, whiteSpace: 'pre-wrap', margin: '4px 0' }}>{json(e.after)}</pre></>}
                      </details>
                    ) : <span className="subtle">—</span>}
                  </td>
                </tr>
              ))}
              {page.rows.length === 0 && <tr><td colSpan={5}><div className="tbl-empty">No events match{actor.sites !== 'all' ? ' within your sites' : ''}.</div></td></tr>}
            </tbody>
          </table>
        </div>
        <div className="card-foot"><span>{page.rows.length} {page.rows.length === 1 ? 'event' : 'events'} shown</span>{older && <LinkButton variant="ghost" size="sm" href={older}>Older events</LinkButton>}</div>
      </GlassCard>
    </>
  )
}
