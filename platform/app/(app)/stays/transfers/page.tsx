import Link from 'next/link'
import { requirePage } from '@/server/auth/page'
import { can } from '@/server/policy'
import { listTransfers } from '@/server/queries/stays/transfers'
import { listStays } from '@/server/queries/stays/stays'
import { Badge, Blocked, GlassCard, PageHeader } from '@/ui'
import { fmtDate } from '@/domain/time'
import { SwapForm } from '../_components/SwapForm'
import { TransferActions } from '../_components/TransferActions'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Transfers & swaps · Grand Hyatt Staff Accommodation' }

const TONE: Record<string, 'brand' | 'success' | 'danger' | 'neutral' | 'info' | 'warning'> = { requested: 'brand', approved: 'info', executed: 'success', failed: 'danger', rejected: 'neutral', cancelled: 'neutral' }
const LABEL: Record<string, string> = { requested: 'Waiting for approval', approved: 'Approved: waiting for Reception', executed: 'Done', failed: 'Failed: nobody moved', rejected: 'Rejected', cancelled: 'Withdrawn' }

export default async function Transfers({ searchParams }: { searchParams: Record<string, string | string[] | undefined> }) {
  const cur = await requirePage('transfers_swaps.view')
  const { actor } = cur.rc
  const all = searchParams.all === '1'
  const rows = await listTransfers(actor, { status: all ? undefined : 'open' })
  const canPropose = can(actor, 'transfers_swaps.approve')
  const active = canPropose ? (await listStays(actor, { status: 'active', limit: 500 })).rows.filter(s => s.name !== 'Resident') : []

  return (
    <>
      <PageHeader crumbs={['Accommodation', 'Stays']} title="Transfers & swaps"
        summary="Moves are approved by an Accommodation Admin who is not part of the request, then carried out by Reception in one step. If the new bed is no longer free, nobody moves and the request says what to do next."
        actions={<><Link href={all ? '/stays/transfers' : '/stays/transfers?all=1'} className="btn secondary" style={{ textDecoration: 'none' }}>{all ? 'Show open only' : 'Show all'}</Link><Link href="/stays" className="btn secondary" style={{ textDecoration: 'none' }}>Back to stays</Link></>} />
      <div className="grid two">
        <div className="stack">
          {rows.length === 0 && <GlassCard><div className="tbl-empty">{all ? 'No transfers or swaps yet.' : 'Nothing is waiting. Residents can ask to move from their stay page.'}</div></GlassCard>}
          {rows.map(t => (
            <GlassCard key={t.id} title={t.kind === 'swap' ? `Swap: ${t.name} and ${t.otherName}` : `Move: ${t.name}`} subtitle={t.reason}
              actions={<Badge tone={TONE[t.status] ?? 'neutral'}>{LABEL[t.status] ?? t.status}</Badge>}>
              <dl className="kv" style={{ marginBottom: 12 }}>
                <dt>From</dt><dd>{t.fromBedLabel}</dd>
                <dt>To</dt><dd>{t.kind === 'swap' ? `${t.otherName}'s bed (they take yours)` : t.toBedLabel ?? 'Any suitable bed: the Accommodation Admin chooses'}</dd>
                {t.neededBy && <><dt>Needed by</dt><dd>{fmtDate(t.neededBy)}</dd></>}
                {t.decisionReason && <><dt>Decision</dt><dd>{t.decisionReason}</dd></>}
              </dl>
              {t.status === 'failed' && t.failureReason && <div style={{ marginBottom: 12 }}><Blocked why={t.failureReason} owner="Accommodation Admin" next={t.failureNext ?? 'Choose another destination bed and approve the move again'} /></div>}
              <TransferActions t={t} />
            </GlassCard>
          ))}
        </div>
        {canPropose && <div className="stack" style={{ alignSelf: 'start' }}><SwapForm choices={active.map(s => ({ stayId: s.id, label: `${s.name} · ${s.bedLabel}` }))} /></div>}
      </div>
    </>
  )
}
