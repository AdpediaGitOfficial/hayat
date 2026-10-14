import Link from 'next/link'
import { requirePage } from '@/server/auth/page'
import { getDb } from '@/server/db/client'
import { listBulkBatches } from '@/server/queries/requests/bulk'
import { requestableSites } from '@/server/queries/requests/preview'
import { Badge, Blocked, GlassCard, PageHeader } from '@/ui'
import { LinkButton, fmtStamp } from '../_components/format'
import { BulkStart } from '../_components/BulkActions'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Bulk allocation · Grand Hyatt Staff Accommodation' }

const TONE = { previewed: 'brand', confirmed: 'success', partial: 'warning', discarded: 'neutral' } as const

export default async function BulkAllocation() {
  const cur = await requirePage('checkin_checkout.allocate_bulk')
  const db = getDb()
  const [sites, batches] = await Promise.all([requestableSites(db, cur.rc.actor), listBulkBatches(db, cur.rc.actor)])
  return (
    <>
      <PageHeader crumbs={['Requests']} title="Bulk allocation" summary="Select people, auto-match eligible beds, check the preview, confirm. Each row is reserved on its own, so a failed row can be retried safely."
        actions={<LinkButton href="/requests">Requests</LinkButton>} />
      {sites.length === 0
        ? <Blocked why="You have no site to allocate for" owner="Super Admin" next="Ask a Super Admin to assign your sites" />
        : <BulkStart sites={sites.map(s => ({ id: s.id, name: s.name }))} />}
      <GlassCard title="Recent previews" subtitle="Open one to confirm it, retry failed rows or see the per-row result" flush>
        <div className="tbl-wrap"><table className="tbl stack-m"><thead><tr><th>Created</th><th>Site</th><th>Status</th></tr></thead><tbody>
          {batches.map(b => (
            <tr key={b.id}>
              <td data-h="Created" className="tnum"><Link href={`/requests/bulk/${b.id}`}>{fmtStamp(b.createdAt.toISOString())}</Link></td>
              <td data-h="Site">{b.siteName}</td>
              <td data-h="Status"><Badge tone={TONE[b.status]}>{b.status === 'previewed' ? 'Preview' : b.status === 'partial' ? 'Partly done' : b.status === 'confirmed' ? 'Confirmed' : 'Discarded'}</Badge></td>
            </tr>
          ))}
          {batches.length === 0 && <tr><td colSpan={3}><div className="tbl-empty">No bulk allocation yet.</div></td></tr>}
        </tbody></table></div>
      </GlassCard>
    </>
  )
}
