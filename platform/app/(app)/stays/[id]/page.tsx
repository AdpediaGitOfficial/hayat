import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requirePage } from '@/server/auth/page'
import { getStayDetail, stayAbilities, transferOptions, transferSites } from '@/server/queries/stays/stays'
import { Alert, Badge, Blocked, GlassCard, PageHeader, Status } from '@/ui'
import { fmtDate, fmtDateLong } from '@/domain/time'
import { FlagBadge } from '../_components/FlagBadge'
import { CancelRequest, CheckoutRequestForm, Clash, ExtensionDecision, ExtensionForm, ProcessCheckout, TransferForm } from '../_components/StayActions'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Stay · Grand Hyatt Staff Accommodation' }

const STATUS: Record<string, string> = { active: 'Active', checked_out: 'Checked out', closed: 'Closed', provisional: 'Provisional', resolution_pending: 'Pending' }

export default async function StayPage({ params }: { params: { id: string } }) {
  const cur = await requirePage('reservations_stays.view')
  const { actor } = cur.rc
  const d = await getStayDetail(actor, params.id)
  if (!d) notFound()
  const ab = stayAbilities(actor, { siteId: d.siteId, staffId: d.staffId })
  const active = d.status === 'active'
  const ctx = { id: d.id, name: d.name, from: d.from, to: d.to, active }
  const canAsk = active && ab.requestTransfer && !d.openTransfer
  const options = canAsk ? await transferOptions(actor, d.id) : []
  const sites = canAsk ? await transferSites(d.siteId) : []
  const today = new Date(cur.rc.clock.now()).toISOString().slice(0, 10)
  const ext = d.openExtension
  const canDecideExt = !!ext && (ext.beyondPolicy ? ab.approveExtensionBeyond : ab.approveExtension) && actor.staffId !== d.staffId && actor.staffId !== ext.requestedByStaffId
  const clash = ext?.clash as { message?: string; suggestions?: { bedId: string; code: string; roomName: string; state: string }[] } | null | undefined

  return (
    <>
      <PageHeader
        crumbs={['Accommodation', 'Stays', d.name]} title={d.name}
        summary={<span className="row wrap"><Status s={STATUS[d.status] ?? d.status} /><FlagBadge s={d} /><span className="muted body-sm">{d.bedLabel}</span></span>}
        actions={<Link href="/stays" className="btn secondary" style={{ textDecoration: 'none' }}>Back to stays</Link>}
      />
      {d.flag === 'escalated' && <Blocked why={`Overdue by ${d.daysOver} days: escalated to the Policy Approver`} owner="Reception, with the Accommodation Admin" next="Check the resident out when they have left, or extend the stay. Nobody is moved or checked out automatically" />}
      {d.flag === 'overdue' && <Blocked why={`The planned end date (${fmtDate(d.to!)}) has passed`} owner="Reception" next="Check the resident out when they leave, or ask the Accommodation Admin to extend the stay" />}

      <div className="grid two">
        <div className="stack">
          <GlassCard title="Stay">
            <dl className="kv">
              <dt>Resident</dt><dd>{d.name}{d.employeeId && <span className="mono muted"> {d.employeeId}</span>}</dd>
              <dt>Bed</dt><dd>{d.bedLabel} <Badge tone="neutral" outline>{d.bedState.replace(/_/g, ' ')}</Badge></dd>
              <dt>Arrived</dt><dd>{fmtDateLong(d.checkedInAt.slice(0, 10))}</dd>
              <dt>Planned end</dt><dd>{d.to ? `${fmtDateLong(d.to)} (the departure day)` : 'Open-ended'}{d.daysLeft !== null && active && d.flag !== 'overdue' && d.flag !== 'escalated' ? ` · ${d.daysLeft} day${d.daysLeft === 1 ? '' : 's'} left` : ''}</dd>
              {d.checkedOutAt && <><dt>Checked out</dt><dd>{fmtDateLong(d.checkedOutAt.slice(0, 10))}</dd></>}
              <dt>Type</dt><dd>{d.stayType}</dd>
            </dl>
          </GlassCard>

          {ext && (
            <GlassCard title="Extension waiting" subtitle={`Until ${fmtDateLong(ext.newEnd)} (+${ext.addedDays} days) · ${ext.beyondPolicy ? 'Policy Approver decides (beyond policy)' : 'Accommodation Admin decides'}`}>
              {ext.reason && <p className="body-sm">{ext.reason}</p>}
              {clash && <div style={{ marginBottom: 12 }}><Clash stayId={d.id} extensionId={ext.id} clash={{ message: clash.message ?? 'The next booking clashes.', suggestions: clash.suggestions ?? [] }} canOpenTransfer={ab.requestTransfer && !ab.mine} /></div>}
              <ExtensionDecision id={ext.id} canDecide={canDecideExt} why={canDecideExt ? undefined : ab.mine || actor.staffId === ext.requestedByStaffId ? 'You cannot decide an extension that is about you or that you raised (separation of duties). An independent approver decides it.' : 'Waiting for the approver.'} />
              {(ab.mine || actor.staffId === ext.requestedByStaffId) && <div style={{ marginTop: 8 }}><CancelRequest kind="extension" id={ext.id} /></div>}
            </GlassCard>
          )}

          {d.openTransfer && (
            <GlassCard title={d.openTransfer.kind === 'swap' ? 'Bed swap waiting' : d.openTransfer.crossSite ? `Move to ${d.openTransfer.toSiteName} waiting` : 'Move waiting'} subtitle={d.openTransfer.reason}>
              <div className="row wrap"><Status s={d.openTransfer.status === 'approved' ? 'Approved' : d.openTransfer.status === 'failed' ? 'Failed' : 'Pending'} label={d.openTransfer.status === 'approved' ? 'Approved, waiting for Reception' : d.openTransfer.status === 'failed' ? 'Could not be carried out: nobody moved' : d.openTransfer.waitingFor ? `Waiting for ${d.openTransfer.waitingFor}` : 'Waiting for approval'} />
                <Link href="/stays/transfers">Open transfers</Link></div>
              {d.openTransfer.crossSite && (
                <dl className="kv" style={{ marginTop: 8 }}>
                  <dt>{d.openTransfer.fromSiteName}</dt><dd>{d.openTransfer.keys.source.approved ? 'Approved (lets the resident go)' : 'Not yet approved'}</dd>
                  <dt>{d.openTransfer.toSiteName}</dt><dd>{d.openTransfer.keys.destination.approved ? 'Approved (takes the resident)' : 'Not yet approved'}</dd>
                </dl>
              )}
              {d.openTransfer.crossSite && d.openTransfer.waitingFor && d.openTransfer.status !== 'failed' && (
                <div style={{ marginTop: 8 }}><Blocked why={`Waiting for ${d.openTransfer.waitingFor}`} owner="Accommodation Admin of the site that has not approved yet" next="They approve it from their approvals inbox. Nobody moves until both sites have approved" /></div>
              )}
              {d.openTransfer.failureReason && <div style={{ marginTop: 8 }}><Blocked why={d.openTransfer.failureReason} owner="Accommodation Admin" next="Choose another destination bed and approve the move again" /></div>}
            </GlassCard>
          )}

          <GlassCard title="History" subtitle="Extensions, moves and checkout requests for this stay">
            {d.extensions.length + d.transfers.length + d.checkouts.length === 0 ? <p className="muted">Nothing has been requested for this stay.</p> : (
              <ul className="list-plain" aria-label="Stay history">
                {d.extensions.map(e => <li key={e.id} style={{ flexWrap: 'wrap' }}><span style={{ flex: 1, minWidth: 180 }}>Extension until {fmtDate(e.newEnd)}<span className="muted body-sm" style={{ display: 'block' }}>{e.decisionReason ?? e.reason ?? ''}</span></span><Badge tone={e.status === 'approved' ? 'success' : e.status === 'requested' ? 'brand' : 'neutral'}>{e.status}</Badge></li>)}
                {d.transfers.map(t => <li key={t.id} style={{ flexWrap: 'wrap' }}><span style={{ flex: 1, minWidth: 180 }}>{t.kind === 'swap' ? 'Bed swap' : 'Move'}{t.crossSite ? ` (${t.fromSiteName} to ${t.toSiteName})` : ''}{t.toBedLabel ? ` to ${t.toBedLabel}` : ''}<span className="muted body-sm" style={{ display: 'block' }}>{t.failureReason ?? t.reason}</span></span><Badge tone={t.status === 'executed' ? 'success' : t.status === 'failed' ? 'danger' : t.status === 'rejected' || t.status === 'cancelled' ? 'neutral' : 'brand'}>{t.status}</Badge></li>)}
                {d.checkouts.map(c => <li key={c.id} style={{ flexWrap: 'wrap' }}><span style={{ flex: 1, minWidth: 180 }}>Checkout on {fmtDate(c.departureDate)}</span><Badge tone={c.status === 'completed' ? 'success' : c.status === 'cancelled' ? 'neutral' : 'brand'}>{c.status}</Badge></li>)}
              </ul>
            )}
          </GlassCard>
        </div>

        <div className="stack" style={{ alignSelf: 'start' }}>
          {!active && <Alert tone="info" title={`This stay is ${STATUS[d.status]?.toLowerCase() ?? d.status}`} detail="Nothing more can be requested for it." />}
          {active && ab.requestExtension && !ext && d.to && <ExtensionForm stay={ctx} policyDays={d.policyDays} canOpenTransfer={ab.requestTransfer && !ab.mine} />}
          {active && ab.requestTransfer && !d.openTransfer && <TransferForm stay={ctx} options={options} sites={sites} currentSiteName={d.siteName} />}
          {active && ab.requestCheckout && !d.openCheckout && <CheckoutRequestForm stay={ctx} today={today} />}
          {active && ab.mine && d.openCheckout && <GlassCard title="Checkout requested" subtitle={`Leaving on ${fmtDate(d.openCheckout.departureDate)}`}><div className="row wrap"><Status s={d.openCheckout.status === 'acknowledged' ? 'Accepted' : 'Pending'} label={d.openCheckout.status === 'acknowledged' ? 'Reception has confirmed' : 'Waiting for Reception to confirm'} /><CancelRequest kind="checkout" id={d.openCheckout.id} /></div></GlassCard>}
          {active && ab.processCheckout && <ProcessCheckout stay={ctx} requested={d.openCheckout} />}
        </div>
      </div>
    </>
  )
}
