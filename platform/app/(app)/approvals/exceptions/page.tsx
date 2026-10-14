import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requirePage } from '@/server/auth/page'
import { getDb } from '@/server/db/client'
import { exceptionReportScope, listExceptions } from '@/server/queries/requests/exceptions'
import { Badge, GlassCard, PageHeader } from '@/ui'
import { LinkButton, fmtStamp } from '../../requests/_components/format'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Exceptions · Grand Hyatt Staff Accommodation' }

export default async function Exceptions() {
  const cur = await requirePage()
  if (!exceptionReportScope(cur.rc.actor)) notFound()
  const rows = (await listExceptions(getDb(), cur.rc.actor, { limit: 100 })) ?? []
  return (
    <>
      <PageHeader crumbs={['Approvals']} title="Exceptions and their uses" summary="Every gender and grade exception a Policy Approver granted, the reason and evidence, and every time it was used."
        actions={<LinkButton href="/approvals">Approvals</LinkButton>} />
      <GlassCard strong flush>
        <div className="tbl-wrap"><table className="tbl stack-m"><thead><tr><th>Person</th><th>Exception</th><th>Reason and evidence</th><th>Granted</th><th>Uses</th></tr></thead><tbody>
          {rows.map(e => (
            <tr key={e.id} data-testid="exception-row">
              <td data-h="Person"><b>{e.name}</b><div className="subtle body-sm mono">{e.employeeId}</div>{e.siteName && <div className="subtle body-sm">{e.siteName}</div>}</td>
              <td data-h="Exception"><Badge tone="brand" dot={false}>{e.kind === 'gender' ? 'Gender' : 'Grade'}</Badge>{e.revoked && <> <Badge tone="neutral">Revoked</Badge></>}{e.requestId && <div className="body-sm"><Link href={`/requests/${e.requestId}`}>Open request</Link></div>}</td>
              <td data-h="Reason and evidence"><div>{e.reason}</div><div className="muted body-sm">Evidence: {e.evidence}</div></td>
              <td data-h="Granted" className="tnum">{fmtStamp(e.grantedAt)}<div className="subtle body-sm">{e.grantedBy ?? ''}</div></td>
              <td data-h="Uses">{e.uses.length === 0 ? <span className="muted">Not used yet</span> : <ul className="list-plain">{e.uses.map(u => <li key={u.id}><span className="body-sm">{u.usedFor} · <span className="tnum">{fmtStamp(u.at)}</span></span></li>)}</ul>}</td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={5}><div className="tbl-empty">No exceptions have been granted yet.</div></td></tr>}
        </tbody></table></div>
      </GlassCard>
    </>
  )
}
