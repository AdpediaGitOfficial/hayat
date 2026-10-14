import { requirePage } from '@/server/auth/page'
import { decide } from '@/server/policy'
import { listConfig, type ConfigRow } from '@/server/queries/access/config'
import { selectableSites } from '@/server/queries/access/sites'
import { Alert, Badge, GlassCard, PageHeader } from '@/ui'
import { EditConfigButton } from './components'
import { LinkButton } from '../users/link-button'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Configuration · Grand Hyatt Staff Accommodation' }

const GROUPS: Record<string, { title: string; subtitle: string }> = {
  auth: { title: 'Sign-in and sessions', subtitle: 'Password and session policy' },
  calendar: { title: 'Calendar', subtitle: 'Weekends and holidays for business-day timers' },
  timers: { title: 'Timers', subtitle: 'Reminders and escalations. They never approve, reject, move or check anyone out.' },
  import: { title: 'Staff import', subtitle: 'How a CSV with some invalid rows is handled' },
}

const show = (v: unknown) => (Array.isArray(v) ? (v.length ? v.join(', ') : 'none') : String(v))
const statusBadge = (r: Pick<ConfigRow, 'status' | 'ref'>) =>
  r.status === 'open' ? <Badge tone="warning">Open · {r.ref}</Badge> : r.status === 'default' ? <Badge tone="info">Default · {r.ref}</Badge> : <Badge tone="success">Decided · {r.ref}</Badge>

function Rows({ rows, canManage, sites }: { rows: ConfigRow[]; canManage: boolean; sites: { id: string; code: string; name: string }[] }) {
  return (
    <div className="tbl-wrap">
      <table className="tbl stack-m">
        <thead><tr><th>Setting</th><th>Current value</th><th>Source</th><th>Decision</th><th /></tr></thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.key} data-testid={`config-${r.key}`}>
              <td data-h="Setting"><b>{r.label}</b><div className="subtle body-sm mono">{r.key}</div></td>
              <td data-h="Current value"><b className="tnum" data-testid="config-value">{show(r.value)}</b>
                {r.value !== r.default && JSON.stringify(r.value) !== JSON.stringify(r.default) && <div className="subtle body-sm">Default {show(r.default)}</div>}
                {r.overrides.map(o => <div key={o.siteId} className="subtle body-sm">{o.siteCode}: {show(o.value)} (v{o.version}){o.valid ? '' : ' · invalid, default applies'}</div>)}
              </td>
              <td data-h="Source" className="muted body-sm">
                {r.source === 'saved' ? <>Saved · v{r.version}<div className="subtle">{r.changedBy ?? '—'}, {r.changedAt ? r.changedAt.slice(0, 10) : ''}</div></> : r.storedInvalid ? <Badge tone="warning">Saved value invalid, default applies</Badge> : 'Default'}
              </td>
              <td data-h="Decision">{statusBadge(r)}{r.perSite && <div className="subtle body-sm">Can differ per site</div>}</td>
              <td data-h="" style={{ textAlign: 'right' }}>
                <span className="row" style={{ justifyContent: 'flex-end' }}>
                  <LinkButton variant="ghost" size="sm" href={`/config/${encodeURIComponent(r.key)}`}>History</LinkButton>
                  {canManage && <EditConfigButton sites={r.perSite ? sites : []} row={{ key: r.key, label: r.label, description: r.description, default: r.default, value: r.value, options: r.options, perSite: r.perSite, overrides: r.overrides.map(o => ({ siteId: o.siteId, value: o.value })) }} />}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default async function ConfigPage() {
  const cur = await requirePage('system_config.view')
  const { actor } = cur.rc
  const rows = await listConfig(actor)
  const canManage = decide(actor, 'system_config.manage').allowed
  const sites = await selectableSites(actor, 'system_config.view')
  const open = rows.filter(r => r.status === 'open')
  return (
    <>
      <PageHeader crumbs={['System']} title="Configuration"
        summary="Every value shown here has a default from the decision log. A change is saved as a new version with a reason; earlier versions are kept." />
      {open.length > 0 && (
        <GlassCard strong flush title={`Open decisions (${open.length})`} subtitle="Placeholders until Grand Hyatt answers. Nothing depends on them being hard-coded: change them here when the answer arrives.">
          <Rows rows={open} canManage={canManage} sites={sites} />
        </GlassCard>
      )}
      {Object.entries(GROUPS).map(([g, meta]) => {
        const list = rows.filter(r => r.group === g && r.status !== 'open') // open ones are shown above, once
        return list.length ? (
          <GlassCard key={g} strong flush title={meta.title} subtitle={meta.subtitle}><Rows rows={list} canManage={canManage} sites={sites} /></GlassCard>
        ) : null
      })}
      <Alert tone="info" title="Per-site values" detail="Calendar settings can differ by site. A site value overrides the all-sites value at that site only." />
    </>
  )
}
