import { notFound } from 'next/navigation'
import { requirePage } from '@/server/auth/page'
import { getConfigHistory } from '@/server/queries/access/config'
import { selectableSites } from '@/server/queries/access/sites'
import { configHistoryQuery } from '@/server/queries/access/params'
import { Alert, Badge, GlassCard, PageHeader } from '@/ui'
import { LinkButton } from '../../users/link-button'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Setting history · Grand Hyatt Staff Accommodation' }

const show = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v))

export default async function ConfigHistoryPage({ params, searchParams }: { params: { key: string }; searchParams: { siteId?: string } }) {
  const cur = await requirePage('system_config.view')
  const key = decodeURIComponent(params.key)
  const q = configHistoryQuery.safeParse({ siteId: searchParams.siteId })
  const h = await getConfigHistory(cur.rc.actor, key, q.success ? q.data.siteId : undefined)
  if (!h) notFound()
  const sites = h.row.perSite ? await selectableSites(cur.rc.actor, 'system_config.view') : []
  return (
    <>
      <PageHeader crumbs={['System', 'Configuration']} title={h.row.label} summary={<span className="mono">{h.row.key}</span>}
        actions={<LinkButton href="/config">All settings</LinkButton>} />
      <Alert tone={h.row.status === 'open' ? 'warning' : 'info'} title={`${h.row.status === 'open' ? 'Open decision' : h.row.status === 'default' ? 'Recommended default' : 'Decided'} · ${h.row.ref}`}
        detail={`${h.row.description || 'No further description.'} Default value: ${show(h.row.default)}.`} />
      {h.row.perSite && (
        <GlassCard title="Scope" subtitle="This setting can differ by site">
          <div className="row wrap">
            <LinkButton variant={!q.success || !q.data.siteId ? 'primary' : 'secondary'} size="sm" href={`/config/${encodeURIComponent(key)}`}>All sites</LinkButton>
            {sites.map(s => <LinkButton key={s.id} variant={q.success && q.data.siteId === s.id ? 'primary' : 'secondary'} size="sm" href={`/config/${encodeURIComponent(key)}?siteId=${s.id}`}>{s.code}</LinkButton>)}
          </div>
        </GlassCard>
      )}
      <GlassCard strong flush title="Versions" subtitle="Newest first. The newest valid version is the one in use.">
        <div className="tbl-wrap"><table className="tbl stack-m"><thead><tr><th>Version</th><th>Value</th><th>Reason</th><th>Decision</th><th>Saved by</th></tr></thead>
          <tbody>
            {h.versions.map((v, i) => (
              <tr key={v.version} data-testid="config-version">
                <td data-h="Version" className="tnum"><b>v{v.version}</b>{i === 0 && v.valid && <> <Badge tone="success">In use</Badge></>}{!v.valid && <> <Badge tone="warning">Invalid, ignored</Badge></>}</td>
                <td data-h="Value" className="mono">{show(v.value)}</td>
                <td data-h="Reason">{v.reason ?? '—'}</td>
                <td data-h="Decision">{v.decisionRef ?? '—'}{v.decisionStatus ? ` · ${v.decisionStatus}` : ''}</td>
                <td data-h="Saved by">{v.changedBy ?? 'System'}<div className="subtle body-sm tnum">{v.changedAt.replace('T', ' ').slice(0, 16)} UTC</div></td>
              </tr>
            ))}
            {h.versions.length === 0 && <tr><td colSpan={5}><div className="tbl-empty">Never saved: the default applies.</div></td></tr>}
          </tbody></table></div>
      </GlassCard>
    </>
  )
}
