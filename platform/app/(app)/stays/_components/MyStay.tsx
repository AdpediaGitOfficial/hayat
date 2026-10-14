import Link from 'next/link'
import type { ReactNode } from 'react'
import type { CurrentUser } from '@/server/auth/current'
import { getStayDetail, listStays, receptionMayRaise, stayAbilities, transferOptions, transferSites } from '@/server/queries/stays/stays'
import { Alert, Blocked, GlassCard, Status } from '@/ui'
import { fmtDate, fmtDateLong } from '@/domain/time'
import { FlagBadge } from './FlagBadge'
import { CancelRequest, CheckoutRequestForm, ExtensionForm, TransferForm } from './StayActions'

/**
 * The resident's own stay on /my: where they live, until when, what they have asked for and where each request stands.
 * Every waiting or blocked state says what is happening, who owns the next step and what to do (D-93).
 */
export async function renderMyStay(cur: CurrentUser): Promise<ReactNode | null> {
  const { actor } = cur.rc
  if (!actor.staffId) return null
  const now = cur.rc.clock.now()
  const mine = await listStays(actor, { staffId: actor.staffId, status: 'occupying', limit: 1 }, now)
  const current = mine.rows[0]
  if (!current) {
    const last = (await listStays(actor, { staffId: actor.staffId, status: 'checked_out', limit: 1 }, now)).rows[0]
    if (!last) return null
    return (
      <GlassCard title="My stay" subtitle="Your last stay">
        <p className="body-sm">You checked out of {last.bedLabel} on {last.checkedOutAt ? fmtDateLong(last.checkedOutAt.slice(0, 10)) : fmtDateLong(last.to ?? last.from)}. Your history stays on your profile. To stay with us again, ask for a bed from the home page.</p>
      </GlassCard>
    )
  }
  const d = await getStayDetail(actor, current.id, now)
  if (!d) return null
  const ab = stayAbilities(actor, { siteId: d.siteId, staffId: d.staffId }, { receptionMayRaise: await receptionMayRaise() })
  const active = d.status === 'active'
  const ctx = { id: d.id, name: d.name, from: d.from, to: d.to, active }
  const canAsk = active && ab.requestTransfer && !d.openTransfer
  const options = canAsk ? await transferOptions(actor, d.id, now) : []
  const sites = canAsk ? await transferSites(d.siteId) : []
  const today = now.toISOString().slice(0, 10)
  const ext = d.openExtension
  const tr = d.openTransfer
  const co = d.openCheckout

  return (
    <div className="stack">
      <GlassCard title="My stay" subtitle={d.bedLabel} actions={<Link href={`/stays/${d.id}`} className="btn ghost sm" style={{ textDecoration: 'none' }}>Details</Link>}>
        <div className="row wrap" style={{ marginBottom: 8 }}><Status s={d.status === 'active' ? 'Active' : d.status === 'provisional' ? 'Provisional' : 'Pending'} /><FlagBadge s={d} /></div>
        <dl className="kv">
          <dt>Arrived</dt><dd>{fmtDateLong(d.checkedInAt.slice(0, 10))}</dd>
          <dt>Planned end</dt><dd>{d.to ? `${fmtDateLong(d.to)} (the day you leave)` : 'Open-ended'}</dd>
        </dl>
        {(d.flag === 'overdue' || d.flag === 'escalated') && (
          <div style={{ marginTop: 12 }}><Blocked why={`Your planned end date (${fmtDate(d.to!)}) has passed`} owner="Reception" next="Arrange your checkout with Reception, or ask for an extension below. Nobody will move you without asking." /></div>
        )}
        {d.status === 'provisional' && <div style={{ marginTop: 12 }}><Alert tone="info" title="Your emergency stay is waiting for approval" detail="An Accommodation Admin decides it. You stay where you are until then." /></div>}
      </GlassCard>

      {ext && (
        <GlassCard title="Extension requested" subtitle={`Until ${fmtDateLong(ext.newEnd)} (+${ext.addedDays} days)`}>
          <div className="row wrap"><Status s="Pending" label={ext.beyondPolicy ? 'Waiting for a Policy Approver' : 'Waiting for an Accommodation Admin'} /></div>
          {ext.clash ? <div style={{ marginTop: 8 }}><Blocked why="Your bed is booked after your current end date" owner="Accommodation Admin" next="They will offer you a move to another bed so you can stay longer" /></div>
            : <p className="muted body-sm">Owner: {ext.beyondPolicy ? 'Policy Approver' : 'Accommodation Admin'}. You will be notified; no action needed. Your stay still ends on {fmtDate(ext.currentEnd)} until it is approved.</p>}
          <div style={{ marginTop: 8 }}><CancelRequest kind="extension" id={ext.id} /></div>
        </GlassCard>
      )}
      {tr && (
        <GlassCard title={tr.kind === 'swap' ? 'Bed swap proposed' : tr.crossSite ? `Move to ${tr.toSiteName} requested` : 'Move requested'} subtitle={tr.reason}>
          <div className="row wrap"><Status s={tr.status === 'approved' ? 'Approved' : tr.status === 'failed' ? 'Failed' : 'Pending'} label={tr.status === 'approved' ? 'Approved: Reception will arrange the move' : tr.status === 'failed' ? 'Could not be done: you stay where you are' : tr.waitingFor ? `Waiting for ${tr.waitingFor}` : 'Waiting for an Accommodation Admin'} /></div>
          {tr.crossSite && (
            <dl className="kv" style={{ marginTop: 8 }}>
              <dt>{tr.fromSiteName}</dt><dd>{tr.keys.source.approved ? 'Agreed to let you go' : 'Not yet approved'}</dd>
              <dt>{tr.toSiteName}</dt><dd>{tr.keys.destination.approved ? 'Agreed to take you' : 'Not yet approved'}</dd>
            </dl>
          )}
          {tr.crossSite && tr.status === 'requested' && (
            <p className="muted body-sm">Owner: {tr.waitingFor ? tr.waitingFor.replace(/^./, c => c.toUpperCase()) : 'Accommodation Admin'}. You stay where you are until both sites have approved and Reception moves you. You will be notified; no action needed.</p>
          )}
          {tr.kind === 'swap' && tr.status === 'requested' && <p className="body-sm"><Link href="/stays/transfers">Answer the swap proposal</Link>: it only goes ahead if you both agree.</p>}
          {tr.failureReason && <div style={{ marginTop: 8 }}><Blocked why={tr.failureReason} owner="Accommodation Admin" next="They will choose another bed and contact you" /></div>}
          <div style={{ marginTop: 8 }}><CancelRequest kind="transfer" id={tr.id} /></div>
        </GlassCard>
      )}
      {co && (
        <GlassCard title="Checkout requested" subtitle={`Leaving on ${fmtDateLong(co.departureDate)}`}>
          <div className="row wrap"><Status s={co.status === 'acknowledged' ? 'Accepted' : 'Pending'} label={co.status === 'acknowledged' ? 'Reception has confirmed' : 'Waiting for Reception to confirm (within 1 business day)'} /></div>
          <p className="muted body-sm">Hand in your key and have the room checked at Reception on the day. You keep your login and history.</p>
          <div style={{ marginTop: 8 }}><CancelRequest kind="checkout" id={co.id} /></div>
        </GlassCard>
      )}

      {active && ab.requestExtension && !ext && d.to && <ExtensionForm stay={ctx} policyDays={d.policyDays} canOpenTransfer={false} />}
      {active && ab.requestTransfer && !tr && <TransferForm stay={ctx} options={options} sites={sites} currentSiteName={d.siteName} />}
      {active && ab.requestCheckout && !co && <CheckoutRequestForm stay={ctx} today={today} />}
    </div>
  )
}
