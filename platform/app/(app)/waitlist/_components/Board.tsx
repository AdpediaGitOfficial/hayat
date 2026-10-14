'use client'
import { useEffect, useState } from 'react'
import { Alert, Badge, Blocked, Button, Countdown, DataTable, GlassCard, PageHeader, Person, Status, type Col } from '@/ui'
import { api, post, type ApiFail } from '@/ui/api'
import type { OfferInFlight, QueueEntryView, SiteQueue } from '@/server/queries/waitlist/queue'
import { FormModal } from './FormModal'
import { LeaveButton } from './LeaveButton'
import { Problem } from './Problem'
import { dates, fmtWhen } from './format'

export interface Perms { add: boolean; manage: boolean; offer: boolean; offline: boolean; behalf: boolean; decide: boolean }
interface BedChoice { bedId: string; code: string; roomName: string; state: string; blocked: { reason: string; owner: string; next: string } | null }
type Modal =
  | { kind: 'add' }
  | { kind: 'offer' | 'renew' | 'priority' | 'decide'; entry: QueueEntryView }
  | { kind: 'delivery' | 'behalf' | 'withdraw'; entry: QueueEntryView; offer: OfferInFlight }

const DAY = 86_400_000

/** The admin view of the waitlist: the queue of each site in order, and the offers in flight with their timers. */
export function Board({ queues, sites, categories, perms, needsOverridePassword = false }: { queues: SiteQueue[]; sites: { id: string; name: string }[]; categories: string[]; perms: Perms; needsOverridePassword?: boolean }) {
  const [modal, setModal] = useState<Modal>()
  const close = () => setModal(undefined)
  const total = queues.reduce((n, q) => n + q.entries.length, 0)
  return (
    <>
      <PageHeader eyebrow="Accommodation" title="Waitlist"
        summary={`${total} ${total === 1 ? 'person' : 'people'} waiting for a bed. Position 1 is next. Beds are offered by a person, never automatically; a held bed cannot be given to anyone else.`}
        actions={perms.add ? <Button variant="primary" icon="plus" onClick={() => setModal({ kind: 'add' })}>Add to waitlist</Button> : undefined} />

      {queues.length === 0 && <GlassCard title="No sites in your scope"><div className="tbl-empty">Ask a Super Admin to assign you a site.</div></GlassCard>}
      {queues.map(q => <SiteBlock key={q.siteId} q={q} perms={perms} open={setModal} />)}

      {modal?.kind === 'add' && <AddModal sites={sites} onClose={close} />}
      {modal?.kind === 'offer' && <OfferModal entry={modal.entry} needsOverridePassword={needsOverridePassword} onClose={close} />}
      {modal?.kind === 'renew' && <RenewModal entry={modal.entry} onClose={close} />}
      {modal?.kind === 'priority' && <PriorityModal entry={modal.entry} categories={categories} onClose={close} />}
      {modal?.kind === 'decide' && <DecideModal entry={modal.entry} onClose={close} />}
      {modal?.kind === 'delivery' && <DeliveryModal entry={modal.entry} offer={modal.offer} onClose={close} />}
      {modal?.kind === 'behalf' && <BehalfModal entry={modal.entry} offer={modal.offer} onClose={close} />}
      {modal?.kind === 'withdraw' && <WithdrawModal entry={modal.entry} offer={modal.offer} onClose={close} />}
    </>
  )
}

function SiteBlock({ q, perms, open }: { q: SiteQueue; perms: Perms; open: (m: Modal) => void }) {
  const waiting = q.entries.filter(e => e.status === 'waiting').length
  const inFlight = q.entries.filter(e => e.offer)
  const cols: Col<QueueEntryView>[] = [
    { key: 'pos', header: '#', width: 48, render: e => <b>{e.position}</b> },
    { key: 'who', header: 'Person', render: e => <Person name={e.name} sub={`${e.employeeId}${e.department ? ' · ' + e.department : ''}`} /> },
    { key: 'prio', header: 'Priority', render: e => e.priority ? <Badge tone="brand">{e.priority}</Badge> : e.pendingPriority ? <Badge tone="warning">Requested: {e.pendingPriority.category}</Badge> : <span className="subtle">None</span> },
    { key: 'dates', header: 'Wants', render: e => <span className="body-sm">{dates(e.arrival, e.end)}</span> },
    { key: 'status', header: 'Status', render: e => <Status s={e.status === 'offered' ? 'Offered' : 'Waiting'} /> },
    { key: 'exp', header: 'Entry ends', render: e => <Countdown to={Date.parse(e.expiresAt)} from={Date.parse(e.createdAt)} warnBelowMs={3 * DAY} /> },
    { key: 'dec', header: 'Declines', align: 'r', render: e => e.declines },
    { key: 'act', header: '', render: e => (
      <span className="row wrap" style={{ gap: 6 }}>
        {perms.offer && e.status === 'waiting' && <Button size="sm" variant="primary" onClick={() => open({ kind: 'offer', entry: e })}>Offer a bed</Button>}
        {perms.decide && e.pendingPriority && <Button size="sm" onClick={() => open({ kind: 'decide', entry: e })}>Decide priority</Button>}
        {perms.manage && !e.pendingPriority && <Button size="sm" variant="ghost" onClick={() => open({ kind: 'priority', entry: e })}>Priority</Button>}
        {perms.manage && <Button size="sm" variant="ghost" onClick={() => open({ kind: 'renew', entry: e })}>Renew</Button>}
        {perms.add && <LeaveButton entryId={e.id} who={e.name} hasOffer={!!e.offer} />}
      </span>
    ) },
  ]
  const offerCols: Col<QueueEntryView>[] = [
    { key: 'who', header: 'Person', render: e => <Person name={e.name} sub={e.employeeId} /> },
    { key: 'bed', header: 'Bed held', render: e => <span><b>{e.offer!.bedCode}</b> <span className="subtle">{e.offer!.roomName}</span><br /><span className="body-sm">{dates(e.offer!.from, e.offer!.to)}</span></span> },
    { key: 'deliv', header: 'Delivery', render: e => <DeliveryCell o={e.offer!} /> },
    { key: 'timer', header: 'Answer by', render: e => <TimerCell o={e.offer!} /> },
    { key: 'act', header: '', render: e => (
      <span className="row wrap" style={{ gap: 6 }}>
        {perms.offline && !e.offer!.deliveredAt && <Button size="sm" variant="primary" onClick={() => open({ kind: 'delivery', entry: e, offer: e.offer! })}>Record: informed offline</Button>}
        {perms.behalf && <Button size="sm" onClick={() => open({ kind: 'behalf', entry: e, offer: e.offer! })}>Accept on behalf</Button>}
        {perms.offer && <Button size="sm" variant="ghost" onClick={() => open({ kind: 'withdraw', entry: e, offer: e.offer! })}>Withdraw</Button>}
      </span>
    ) },
  ]
  const overdue = inFlight.filter(e => e.offer && !e.offer.deliveredAt && Date.now() - Date.parse(e.offer.createdAt) >= DAY)
  return (
    <section style={{ marginBottom: 24 }} aria-label={`Waitlist at ${q.siteName}`} data-testid={`queue-${q.siteCode}`}>
      <h2 style={{ margin: '0 0 8px' }}>{q.siteName} <span className="subtle" style={{ fontWeight: 400, fontSize: 14 }}>{q.entries.length} in the queue · {waiting} waiting for an offer</span></h2>
      <DataTable cols={cols} rows={q.entries} rowKey={e => e.id} empty="Nobody is waiting at this site." footer={<span>Priority first, then the oldest waiting entry.</span>} />
      {inFlight.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <h3 style={{ margin: '0 0 8px' }}>Offers in flight</h3>
          <div className="stack" style={{ gap: 8 }}>
            {overdue.map(e => (
              <Blocked key={e.id} why={`${e.name} has not opened the offer for bed ${e.offer!.bedCode} after 24 hours. The 48 hours have not started.`}
                owner="Reception" next="Tell them in person or by phone, then record “informed offline”." />
            ))}
            <DataTable cols={offerCols} rows={inFlight} rowKey={e => e.offer!.id} empty="No offers out." footer={<span>The 48 hours start when the resident opens the offer or staff record that they were told.</span>} />
          </div>
        </div>
      )}
    </section>
  )
}

function DeliveryCell({ o }: { o: OfferInFlight }) {
  if (!o.deliveredAt) return <span><Badge tone="warning">Not delivered</Badge><br /><span className="subtle body-sm">{o.followUpSentAt ? 'Reception was alerted' : 'Waiting for the resident to open it'}</span></span>
  return <span><Badge tone="success">{o.deliveredVia === 'viewed' ? 'Seen in the app' : o.deliveredVia === 'email' ? 'Email confirmed' : 'Informed offline'}</Badge><br /><span className="subtle body-sm">{fmtWhen(o.deliveredAt)}</span></span>
}
function TimerCell({ o }: { o: OfferInFlight }) {
  if (o.expiresAt && o.deliveredAt) return <Countdown to={Date.parse(o.expiresAt)} from={Date.parse(o.deliveredAt)} />
  return <Countdown to={Date.parse(o.createdAt) + DAY} label="Reception follow-up" />
}

/* ---------------- modals ---------------- */

function AddModal({ sites, onClose }: { sites: { id: string; name: string }[]; onClose: () => void }) {
  return (
    <FormModal open onClose={onClose} title="Add to the waitlist" subtitle="The person must be eligible for at least one kind of bed at the site. They join at the back of the queue and the entry is valid for 15 days."
      submitLabel="Add to waitlist"
      fields={[
        { name: 'employeeId', label: 'Employee ID', kind: 'text' },
        { name: 'siteId', label: 'Site', kind: 'select', options: sites.map(s => ({ value: s.id, label: s.name })), initial: sites.length === 1 ? sites[0].id : '' },
        { name: 'arrival', label: 'Wanted from', kind: 'date' },
        { name: 'end', label: 'Until (departure day)', kind: 'date', optional: true, hint: 'Leave empty for an open-ended stay' },
      ]}
      run={v => post('/api/v1/waitlist', { employeeId: v.employeeId, siteId: v.siteId, arrival: v.arrival, end: v.end || null })} />
  )
}

function OfferModal({ entry, needsOverridePassword, onClose }: { entry: QueueEntryView; needsOverridePassword: boolean; onClose: () => void }) {
  const [beds, setBeds] = useState<BedChoice[]>()
  const [loadErr, setLoadErr] = useState<ApiFail>()
  const [override, setOverride] = useState(false)
  useEffect(() => {
    let live = true
    api<BedChoice[]>('GET', `/api/v1/waitlist/${entry.id}/beds`).then(r => { if (!live) return; if (r.ok) setBeds(r.data); else setLoadErr(r) })
    return () => { live = false }
  }, [entry.id])
  const fields = [
    { name: 'bedId', label: 'Bed to hold', kind: 'select' as const, options: (beds ?? []).filter(b => !b.blocked).map(b => ({ value: b.bedId, label: `${b.code} · ${b.roomName}${b.state === 'available' ? '' : ' (not ready yet, later start)'}` })) },
    ...(override ? [{ name: 'overrideReason', label: 'Reason for skipping the queue order', kind: 'text' as const, hint: 'Someone is ahead of this person. The reason is kept in the audit log.' }] : []),
    // D-03 / P-02 (proposed, pending client sign-off): skipping the queue order asks for the password again, when the configuration lists it.
    ...(override && needsOverridePassword ? [{ name: 'confirmPassword', label: 'Confirm with your password', kind: 'password' as const, hint: 'Skipping the queue order is a high-risk action, so we ask again who you are.' }] : []),
  ]
  return (
    <FormModal open onClose={onClose} title={`Offer a bed to ${entry.name}`}
      subtitle="The bed is held for them and nobody else can be given it. The 48 hours start when they open the offer or you record that they were told."
      submitLabel="Hold this bed" fields={fields}
      run={async v => {
        const r = await post(`/api/v1/waitlist/${entry.id}/offer`, { bedId: v.bedId, overrideReason: v.overrideReason || undefined, ...(v.overrideReason && v.confirmPassword ? { confirmPassword: v.confirmPassword } : {}) })
        if (!r.ok && (r.detail as { reason?: string } | undefined)?.reason === 'ahead_in_queue') setOverride(true)
        return r
      }}>
      {loadErr && <Problem f={loadErr} />}
      {beds && beds.length === 0 && <Blocked why="No bed is free for this person's dates." owner="Accommodation Admin" next="Wait for a bed to be released, or adjust the dates when renewing the entry." />}
      {/* P-13 (proposed, pending client sign-off): beds that are not ready cannot be offered for a start inside the lead time; shown with the reason. */}
      {beds && beds.filter(b => b.blocked).map(b => (
        <div key={b.bedId} style={{ marginTop: 8 }} data-testid="offer-blocked-bed"><Blocked why={`${b.code} · ${b.roomName}: ${b.blocked!.reason}`} owner={b.blocked!.owner} next={b.blocked!.next} /></div>
      ))}
    </FormModal>
  )
}

function RenewModal({ entry, onClose }: { entry: QueueEntryView; onClose: () => void }) {
  return (
    <FormModal open onClose={onClose} title={`Renew ${entry.name}'s entry`}
      subtitle="Eligibility is checked again. Renewing before the entry ends with the same dates keeps the place in the queue; changing the dates sends it to the back."
      submitLabel="Renew for 15 days"
      fields={[
        { name: 'arrival', label: 'Wanted from', kind: 'date', initial: entry.arrival },
        { name: 'end', label: 'Until (departure day)', kind: 'date', optional: true, initial: entry.end ?? '' },
      ]}
      run={v => post(`/api/v1/waitlist/${entry.id}/renew`, { arrival: v.arrival || undefined, end: v.end || null })} />
  )
}

function PriorityModal({ entry, categories, onClose }: { entry: QueueEntryView; categories: string[]; onClose: () => void }) {
  return (
    <FormModal open onClose={onClose} title={`Ask for priority for ${entry.name}`}
      subtitle="A Policy Approver decides. Reason and evidence are required and kept with the queue history."
      submitLabel="Send to a Policy Approver"
      fields={[
        { name: 'category', label: 'Priority category', kind: 'select', options: categories.map(c => ({ value: c, label: c })) },
        { name: 'reason', label: 'Reason', kind: 'textarea' },
        { name: 'evidence', label: 'Evidence', kind: 'textarea', hint: 'What supports this (a letter, a reference)' },
      ]}
      run={v => post(`/api/v1/waitlist/${entry.id}/priority`, v)}>
      {categories.length === 0 && <Blocked why="No priority categories are defined yet (open question GH-04)." owner="Super Admin" next="Add the approved categories in Configuration once Grand Hyatt supplies them." />}
    </FormModal>
  )
}

function DecideModal({ entry, onClose }: { entry: QueueEntryView; onClose: () => void }) {
  const p = entry.pendingPriority!
  return (
    <FormModal open onClose={onClose} title={`Priority for ${entry.name}`}
      subtitle={<>Requested: <b>{p.category}</b>. Reason: {p.reason}. Evidence: {p.evidence}</>}
      submitLabel={v => (v.decision === 'reject' ? 'Reject' : 'Approve')} danger={v => v.decision === 'reject'}
      fields={[
        { name: 'decision', label: 'Decision', kind: 'select', options: [{ value: 'approve', label: 'Approve the priority' }, { value: 'reject', label: 'Reject' }], initial: 'approve' },
        { name: 'note', label: 'Note', kind: 'text', optional: true, hint: 'Required when rejecting' },
      ]}
      canSubmit={v => v.decision !== 'reject' || (v.note ?? '').trim().length > 0}
      run={v => post(`/api/v1/waitlist/priority/${p.id}/decide`, { decision: v.decision, note: v.note || undefined })} />
  )
}

function DeliveryModal({ entry, offer, onClose }: { entry: QueueEntryView; offer: OfferInFlight; onClose: () => void }) {
  return (
    <FormModal open onClose={onClose} title={`Record: ${entry.name} was informed`}
      subtitle={`Bed ${offer.bedCode}. This starts the 48 hours. Say how and when you told them.`}
      submitLabel="Record and start the 48 hours"
      fields={[{ name: 'note', label: 'How and when', kind: 'text', hint: 'For example: phoned at 14:10, will answer tonight' }]}
      run={v => post(`/api/v1/waitlist/offers/${offer.id}/delivery`, { via: 'offline', note: v.note })} />
  )
}

function BehalfModal({ entry, offer, onClose }: { entry: QueueEntryView; offer: OfferInFlight; onClose: () => void }) {
  return (
    <FormModal open onClose={onClose} title={`Accept bed ${offer.bedCode} for ${entry.name}`}
      subtitle="Only with the resident's consent. The consent and your name are recorded and audited; the resident is told."
      submitLabel="Accept on their behalf"
      fields={[{ name: 'consent', label: 'Consent given', kind: 'textarea', hint: 'How and when they agreed (in person, by phone), and who was present' }]}
      run={v => post(`/api/v1/waitlist/offers/${offer.id}/accept-on-behalf`, { consent: v.consent })}>
      <Alert tone="warning" title="This creates the reservation now" detail={`${dates(offer.from, offer.to)}. It cannot be undone from here; use Withdraw before accepting if unsure.`} />
    </FormModal>
  )
}

function WithdrawModal({ entry, offer, onClose }: { entry: QueueEntryView; offer: OfferInFlight; onClose: () => void }) {
  return (
    <FormModal open onClose={onClose} title={`Withdraw the offer of bed ${offer.bedCode}`}
      subtitle={`${entry.name} keeps their place in the queue. The bed is released.`}
      submitLabel="Withdraw the offer" danger
      fields={[{ name: 'reason', label: 'Reason', kind: 'text' }]}
      run={v => post(`/api/v1/waitlist/offers/${offer.id}/withdraw`, { reason: v.reason })} />
  )
}
