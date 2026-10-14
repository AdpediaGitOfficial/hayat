import { notFound } from 'next/navigation'
import { requirePage } from '@/server/auth/page'
import { getDb } from '@/server/db/client'
import { isUuid } from '@/server/commands/property/shared'
import { getBulkBatch } from '@/server/queries/requests/bulk'
import { Alert, Badge, GlassCard, PageHeader } from '@/ui'
import { LinkButton, fmtStamp, range } from '../../_components/format'
import { BulkConfirm } from '../../_components/BulkActions'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Bulk allocation · Grand Hyatt Staff Accommodation' }

const OUTCOME = {
  new: { tone: 'success', label: 'Ready to reserve' },
  conflict: { tone: 'warning', label: 'Conflict' },
  not_eligible: { tone: 'warning', label: 'Not eligible' },
  no_request: { tone: 'neutral', label: 'No open request' },
} as const
const RESULT = { pending: { tone: 'info', label: 'Not yet' }, done: { tone: 'success', label: 'Reserved' }, failed: { tone: 'danger', label: 'Not done' }, skipped: { tone: 'neutral', label: 'Skipped' } } as const

export default async function BulkBatchPage({ params }: { params: { id: string } }) {
  const cur = await requirePage('checkin_checkout.allocate_bulk')
  if (!isUuid(params.id)) notFound()
  const b = await getBulkBatch(getDb(), cur.rc.actor, params.id)
  if (!b) notFound()
  const attempted = b.rows.some(r => r.attempts > 0)
  return (
    <>
      <PageHeader crumbs={['Requests', 'Bulk allocation']} title={`Bulk allocation: ${b.siteName}`}
        summary={<span className="row wrap"><Badge tone={b.status === 'confirmed' ? 'success' : b.status === 'partial' ? 'warning' : 'brand'}>{b.status === 'previewed' ? 'Preview' : b.status === 'partial' ? 'Partly done' : b.status}</Badge><span className="muted body-sm">{fmtStamp(b.createdAt)} · {b.counts.total} rows · {b.counts.ready} can be reserved · {b.counts.done} done · {b.counts.failed} not done</span></span>}
        actions={<LinkButton href="/requests/bulk">All previews</LinkButton>} />
      {b.status === 'previewed' && <Alert tone="info" title="Nothing has been reserved yet" detail="This is a preview. Conflicts and eligibility problems are shown per row; only rows marked Ready to reserve are reserved when you confirm." />}
      <GlassCard strong flush title={attempted ? 'Per-row result' : 'Preview'}>
        <div className="tbl-wrap"><table className="tbl stack-m"><thead><tr><th>Person</th><th>Dates</th><th>Matched bed</th><th>Preview</th><th>Result</th></tr></thead><tbody>
          {b.rows.map(r => (
            <tr key={r.id} data-testid="bulk-row">
              <td data-h="Person"><b>{r.name}</b><div className="subtle body-sm mono">{r.employeeId}</div></td>
              <td data-h="Dates" className="tnum">{r.arrivalDate ? range(r.arrivalDate, r.endDate) : <span className="muted">no request</span>}</td>
              <td data-h="Matched bed">{r.bedCode ? <><span className="mono">{r.bedCode}</span><div className="subtle body-sm">Room {r.roomName}</div></> : <span className="muted">none</span>}</td>
              <td data-h="Preview"><Badge tone={OUTCOME[r.outcome].tone}>{OUTCOME[r.outcome].label}</Badge>{r.outcome !== 'new' && <div className="muted body-sm" style={{ marginTop: 4 }}>{r.message}</div>}</td>
              <td data-h="Result">{r.outcome === 'new' ? <><Badge tone={RESULT[r.status].tone}>{RESULT[r.status].label}</Badge>{r.resultMessage && <div className={r.status === 'failed' ? 'body-sm' : 'muted body-sm'} style={{ marginTop: 4 }}>{r.resultMessage}</div>}</> : <span className="muted">{RESULT.skipped.label}</span>}</td>
            </tr>
          ))}
        </tbody></table></div>
      </GlassCard>
      {b.status !== 'discarded' && <BulkConfirm id={b.id} status={b.status} ready={b.counts.pending} failed={b.counts.failed} />}
    </>
  )
}
