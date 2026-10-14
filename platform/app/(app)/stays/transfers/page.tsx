import Link from 'next/link'
import { requirePage } from '@/server/auth/page'
import { can } from '@/server/policy'
import { listTransfers } from '@/server/queries/stays/transfers'
import { listStays, receptionMayRaise } from '@/server/queries/stays/stays'
import { getConfig } from '@/server/config/registry'
import { getDb } from '@/server/db/client'
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
  // Reception raises swaps only while the proposal P-09 is switched on (pending client sign-off); the server refuses it otherwise.
  const canPropose = can(actor, 'transfers_swaps.approve') || (actor.role === 'Rec' && can(actor, 'transfers_swaps.request') && await receptionMayRaise())
  const partnerLookup = canPropose && await getConfig(getDb(), 'transfers.swap_partner_lookup')
  const exceptionPath = await getConfig(getDb(), 'transfers.exception_path')
  const active = canPropose ? (await listStays(actor, { status: 'active', limit: 500 })).rows.filter(s => s.name !== 'Resident') : []

  return (
    <>
      <PageHeader crumbs={['Accommodation', 'Stays']} title="Transfers & swaps"
        summary="Moves are approved by an Accommodation Admin who is not part of the request, then carried out by Reception in one step. A move to another site needs the Accommodation Admin of each site to approve. If the new bed is no longer free, nobody moves and the request says what to do next."
        actions={<><Link href={all ? '/stays/transfers' : '/stays/transfers?all=1'} className="btn secondary" style={{ textDecoration: 'none' }}>{all ? 'Show open only' : 'Show all'}</Link><Link href="/stays" className="btn secondary" style={{ textDecoration: 'none' }}>Back to stays</Link></>} />
      <div className="grid two">
        <div className="stack">
          {rows.length === 0 && <GlassCard><div className="tbl-empty">{all ? 'No transfers or swaps yet.' : 'Nothing is waiting. Residents can ask to move from their stay page.'}</div></GlassCard>}
          {rows.map(t => (
            <GlassCard key={t.id} title={t.kind === 'swap' ? `Swap: ${t.name} and ${t.otherName}` : `Move: ${t.name}`} subtitle={t.reason}
              actions={<><Badge tone={TONE[t.status] ?? 'neutral'}>{t.crossSite && t.status === 'requested' && t.keys.source.approved !== t.keys.destination.approved ? 'Half approved' : LABEL[t.status] ?? t.status}</Badge>{t.crossSite && <Badge tone="info" outline>Between sites</Badge>}</>}>
              <dl className="kv" style={{ marginBottom: 12 }}>
                <dt>From</dt><dd>{t.fromBedLabel}</dd>
                <dt>To</dt><dd>{t.kind === 'swap' ? `${t.otherName}'s bed (they take yours)` : t.toBedLabel ?? (t.crossSite ? `Any suitable bed in ${t.destinationSiteName}: the Accommodation Admin there chooses` : 'Any suitable bed: the Accommodation Admin chooses')}</dd>
                {t.neededBy && <><dt>Needed by</dt><dd>{fmtDate(t.neededBy)}</dd></>}
                {t.crossSite && <>
                  <dt>Out of {t.siteName}</dt><dd>{t.keys.source.approved ? <Badge tone="success">Approved by the Accommodation Admin</Badge> : <Badge tone="brand">Waiting for the Accommodation Admin of {t.siteName}</Badge>}</dd>
                  <dt>Into {t.destinationSiteName}</dt><dd>{t.keys.destination.approved ? <Badge tone="success">Approved by the Accommodation Admin</Badge> : <Badge tone="brand">Waiting for the Accommodation Admin of {t.destinationSiteName}</Badge>}</dd>
                </>}
                {t.decisionReason && <><dt>Decision</dt><dd>{t.decisionReason}</dd></>}
              </dl>
              {t.raisedBy && <p className="muted body-sm" style={{ margin: '0 0 8px' }}>Raised for the resident by {t.raisedBy.name}. Whoever raised a move never approves it.</p>}
              {t.waiting && t.status !== 'failed' && t.crossSite && !t.can.approve && !t.exceptions.some(e => e.state === 'waiting') && <div style={{ marginBottom: 12 }}><Blocked why={t.waiting.text} owner={t.waiting.owner} next={t.waiting.next} /></div>}
              {t.status === 'failed' && t.failureReason && <div style={{ marginBottom: 12 }}><Blocked why={t.failureReason} owner="Accommodation Admin" next={t.failureNext ?? 'Choose another destination bed and approve the move again'} /></div>}
              <TransferActions t={t} />
            </GlassCard>
          ))}
        </div>
        {canPropose && <div className="stack" style={{ alignSelf: 'start' }}><SwapForm choices={active.map(s => ({ stayId: s.id, label: `${s.name} · ${s.bedLabel}` }))} partnerLookup={partnerLookup} exceptionPath={exceptionPath} /></div>}
      </div>
    </>
  )
}
