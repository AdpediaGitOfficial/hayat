import { useEffect, useState } from 'react'
import { useAct, useCtx } from '../ctx'
import { A } from '../domain/store'
import { Alert, Badge, Blocked, Button, Countdown, Field, GlassCard, Icon, Input, Modal, PageHeader, Select, Status, Textarea, Tabs } from '../ui'
import { myStatus, notificationsFor } from '../domain/select'
import { bedById, bedPath, staffById, suggestBeds } from '../domain/rules'
import { addDays, dayDiff, fmtDate, fmtDateTime, greeting, today, DAY } from '../domain/time'

export function ResidentHome() {
  const { s, persona, now, go } = useCtx()
  const act = useAct()
  const me = staffById(s, persona.staffId)!
  const st = myStatus(s, me.id)
  const [sos, setSos] = useState(false)
  const hasWork = persona.caps.includes('Housekeeping')
  const [view, setView] = useState<'stay' | 'work'>('stay')
  const T = today(now)

  // D-51: viewing the offer in-app is confirmed delivery and starts the 48h clock
  useEffect(() => {
    if (st.offer && !st.offer.deliveredAt) A.deliverOffer(persona, st.offer.id, 'viewed')
  }, [st.offer?.id])

  const notifs = notificationsFor(s, persona)
  return (
    <>
      <PageHeader display eyebrow={`RESIDENT · ${fmtDate(now).toUpperCase()}`} title={`${greeting(now)}, ${me.name.split(' ')[0]}`} summary={statusLine(st.status)}
        actions={<>{hasWork && <Tabs value={view} onChange={v => { setView(v); if (v === 'work') go('housekeeping') }} options={[{ id: 'stay', label: 'My stay' }, { id: 'work', label: 'My work' }]} />}
          <Button variant="danger" icon="siren" onClick={() => setSos(true)}>SOS</Button></>} />

      {st.status === 'none' && (
        <GlassCard title="You don’t have accommodation yet" subtitle="Staff accommodation is for active employees. Tell us when you need a bed and for how long.">
          <Button variant="primary" icon="bed" onClick={() => go('request')}>Request a bed</Button>
        </GlassCard>
      )}

      {st.status === 'applied' && st.req && (
        <GlassCard title="Request received" subtitle="An Accommodation Admin decides within 2 business days" actions={<Status s="Submitted" label="Waiting for approval" />}>
          <dl className="kv"><dt>Arrival</dt><dd>{fmtDate(st.req.arrival)}</dd><dt>Planned end</dt><dd>{fmtDate(st.req.end)}</dd><dt>Stay type</dt><dd>{st.req.stayType}</dd><dt>Submitted</dt><dd>{fmtDateTime(st.req.createdAt)}</dd></dl>
          <div className="row" style={{ marginTop: 16 }}><Button onClick={() => act(A.cancelRequest(persona, st.req!.id))}>Cancel request</Button></div>
        </GlassCard>
      )}

      {st.status === 'waitlisted' && st.entry && (
        <GlassCard title="You’re on the waitlist" subtitle="No bed is free yet. We’ll offer one as soon as it is." actions={<Status s="Waiting" />}>
          <div className="stack">
            <div><div className="label">Entry valid for</div><Countdown to={st.entry.expiresAt} from={st.entry.createdAt} warnBelowMs={3 * DAY} /></div>
            <dl className="kv"><dt>Queue position</dt><dd>#{[...s.waitlist].filter(w => w.status === 'Waiting' && w.gender === st.entry!.gender).sort((a, b) => a.queueTs - b.queueTs).findIndex(w => w.id === st.entry!.id) + 1} in your eligible queue</dd>
              <dt>Declines</dt><dd>{st.entry.declines} (a second decline moves you to the back)</dd></dl>
            <Alert tone="info" title="Reminders" detail="We remind you 3 days and 1 day before expiry. Ask the Accommodation Admin to renew." />
          </div>
        </GlassCard>
      )}

      {st.status === 'offered' && st.offer && (
        <OfferCard offerId={st.offer.id} />
      )}

      {st.status === 'reserved' && st.res && (() => {
        const bed = bedById(s, st.res.bedId)!
        return (
          <GlassCard title="Your bed is reserved" subtitle={bedPath(s, bed)} actions={<Status s="Reserved" />}>
            <div className="stack">
              <dl className="kv"><dt>Bed</dt><dd className="mono">{bed.code}</dd><dt>Arrival</dt><dd>{fmtDate(st.res.from)}</dd><dt>Planned end</dt><dd>{st.res.to ? fmtDate(st.res.to) : 'To be agreed'}</dd></dl>
              {bed.state !== 'Available' ? <Blocked why={`Room not ready yet: ${bed.state === 'NeedsCleaning' ? 'needs cleaning' : 'awaiting final inspection'}`} owner="Housekeeping / Reception" next="Reception will check you in as soon as it’s ready" /> : <Alert tone="success" title="Room is ready" detail="Bring your ID to Reception to check in." />}
            </div>
          </GlassCard>
        )
      })()}

      {(st.status === 'staying' || st.status === 'checking-out') && st.stay && <StayCard stayId={st.stay.id} />}

      <div className="grid even">
        <ContactCard />
        <GlassCard title="Notices" subtitle="In-app and email only">
          {notifs.length === 0 ? <div className="muted">No notices.</div> : <ul className="list-plain">{notifs.slice(0, 5).map(n => <li key={n.id}><Icon name="bell" /><div style={{ flex: 1 }}>{n.text}<div className="subtle body-sm">{fmtDateTime(n.at)}{n.email && ' · also emailed'}</div></div></li>)}</ul>}
        </GlassCard>
      </div>
      <SosModal open={sos} onClose={() => setSos(false)} />
    </>
  )
}

const statusLine = (s: string) => ({
  none: 'No accommodation yet', applied: 'Your request is with an Accommodation Admin', waitlisted: 'Waiting for a bed', offered: 'A bed is offered to you. Please respond',
  reserved: 'Your bed is reserved', staying: 'You’re staying with us', 'checking-out': 'Your checkout is being processed',
} as Record<string, string>)[s]

function OfferCard({ offerId }: { offerId: string }) {
  const { s, persona } = useCtx()
  const act = useAct()
  const o = s.offers.find(x => x.id === offerId)!
  const bed = bedById(s, o.bedId)!
  const en = s.waitlist.find(w => w.id === o.entryId)!
  return (
    <GlassCard title="A bed is offered to you" subtitle={bedPath(s, bed)} actions={<Status s="Pending" label="Respond now" />}>
      <div className="stack">
        <div>
          <div className="label">Time to respond</div>
          {o.expiresAt ? <Countdown to={o.expiresAt} from={o.deliveredAt} warnBelowMs={12 * 3600_000} label="from when you were told" /> : <span className="muted">Starting…</span>}
        </div>
        <dl className="kv"><dt>Bed</dt><dd className="mono">{bed.code}</dd><dt>Your waitlist entry</dt><dd>{en.declines === 0 ? 'Declining keeps your place once' : 'Another decline moves you to the back of the queue'}</dd></dl>
        <div className="row wrap"><Button variant="primary" tall icon="check" onClick={() => act(A.acceptOffer(persona, o.id))}>Accept bed</Button><Button tall onClick={() => act(A.declineOffer(persona, o.id))}>Decline</Button></div>
        <p className="subtle body-sm">If you don’t respond in 48 hours the offer is withdrawn and the bed is released. You stay on the waitlist until your entry expires.</p>
      </div>
    </GlassCard>
  )
}

function StayCard({ stayId }: { stayId: string }) {
  const { s, persona, now, go } = useCtx()
  const act = useAct()
  const stay = s.stays.find(x => x.id === stayId)!
  const bed = bedById(s, stay.bedId)!
  const T = today(now)
  const [modal, setModal] = useState<null | 'ext' | 'transfer'>(null)
  const ext = s.extensions.find(e => e.stayId === stay.id && e.status === 'Submitted')
  const tr = s.transfers.find(t => t.stayId === stay.id && ['Submitted', 'Approved'].includes(t.status))
  const left = stay.end ? dayDiff(T, stay.end) : null
  return (
    <>
      <GlassCard title="Your stay" subtitle={bedPath(s, bed)} actions={stay.checkoutRequested ? <Status s="Checkout due" label="Checkout requested" /> : <Status s="CheckedIn" />}>
        <div className="stack">
          <dl className="kv"><dt>Bed</dt><dd className="mono">{bed.code}</dd><dt>Since</dt><dd>{fmtDate(stay.start)}</dd><dt>Planned end</dt><dd>{stay.end ? `${fmtDate(stay.end)} · ${left! >= 0 ? `${left} days left` : `${-left!} days overdue`}` : 'End date pending'}</dd>
            <dt>Keys</dt><dd>{s.keys.filter(k => k.staffId === stay.staffId && k.status === 'Issued').map(k => k.kind).join(', ') || 'None issued'}</dd></dl>
          {ext && <Alert tone="info" title="Extension requested" detail={`Until ${fmtDate(ext.newEnd)}${ext.beyondPolicy ? ' · beyond policy, with the Policy Approver' : ''}`} />}
          {tr && <Alert tone="info" title={`Transfer ${tr.status === 'Approved' ? 'approved' : 'requested'}`} detail={tr.kind === 'Swap' ? 'Swap with another resident' : `To ${bedById(s, tr.destBedId)?.code}. Reception will arrange the move and keys.`} />}
          {stay.checkoutRequested && <Alert tone="info" title="Checkout requested" detail="Reception acknowledges within 1 business day, then keys and room inspection." />}
          <div className="row wrap">
            <Button onClick={() => setModal('ext')} disabled={!!ext || stay.checkoutRequested}>Request extension</Button>
            <Button onClick={() => setModal('transfer')} disabled={!!tr || stay.checkoutRequested}>Request room change</Button>
            <Button onClick={() => go('maintenance')} icon="wrench">Report an issue</Button>
            {!stay.checkoutRequested && <Button variant="danger" onClick={() => act(A.requestCheckout(persona, stay.id))}>Request checkout</Button>}
          </div>
        </div>
      </GlassCard>
      {modal === 'ext' && <ExtensionModal stayId={stay.id} onClose={() => setModal(null)} />}
      {modal === 'transfer' && <TransferModal stayId={stay.id} onClose={() => setModal(null)} />}
    </>
  )
}

function ExtensionModal({ stayId, onClose }: { stayId: string; onClose: () => void }) {
  const { s, persona } = useCtx()
  const act = useAct()
  const stay = s.stays.find(x => x.id === stayId)!
  const [end, setEnd] = useState(addDays(stay.end ?? today(), 60))
  const [reason, setReason] = useState('Contract extended')
  return (
    <Modal open onClose={onClose} title="Request an extension" subtitle="We check bed availability, eligibility and any booking after yours"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={() => act(A.requestExtension(persona, { stayId, newEnd: end, reason }), onClose)}>Send request</Button></>}>
      <Field label="New end date" hint={`Within ${s.config.extensionPolicyDays} days of your current end date is decided by the Accommodation Admin. Longer goes to the Policy Approver.`}><Input type="date" value={end} onChange={e => setEnd(e.target.value)} /></Field>
      <Field label="Reason"><Textarea value={reason} onChange={e => setReason(e.target.value)} /></Field>
    </Modal>
  )
}
function TransferModal({ stayId, onClose }: { stayId: string; onClose: () => void }) {
  const { s, persona } = useCtx()
  const act = useAct()
  const stay = s.stays.find(x => x.id === stayId)!
  const staff = staffById(s, stay.staffId)!
  const options = suggestBeds(s, staff, { from: today(), to: stay.end }, 'all').filter(b => b.state === 'Available' && b.id !== stay.bedId)
  const [dest, setDest] = useState(options[0]?.id ?? '')
  const [reason, setReason] = useState('')
  return (
    <Modal open onClose={onClose} title="Request a room change" subtitle="An admin reviews it. We reserve the new bed before releasing yours"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={() => act(A.requestTransfer(persona, { stayId, destBedId: dest, reason }), onClose)} disabled={!dest}>Send request</Button></>}>
      <Field label="Preferred bed"><Select value={dest} onChange={e => setDest(e.target.value)}>{options.map(b => <option key={b.id} value={b.id}>{b.code}</option>)}</Select></Field>
      <Field label="Reason"><Textarea value={reason} onChange={e => setReason(e.target.value)} /></Field>
    </Modal>
  )
}

function ContactCard() {
  const { s, persona } = useCtx()
  const act = useAct()
  const me = staffById(s, persona.staffId)!
  const [phone, setPhone] = useState(me.phone)
  const [ec, setEc] = useState(me.emergencyContact)
  return (
    <GlassCard title="My details" subtitle="You can edit phone and emergency contact. The rest is managed by the Accommodation Admin.">
      <div className="stack">
        <dl className="kv"><dt>Employee ID</dt><dd className="mono">{me.id}</dd><dt>Department</dt><dd>{me.dept}</dd><dt>National ID</dt><dd className="mono">•••• 4417</dd></dl>
        <Field label="Phone"><Input value={phone} onChange={e => setPhone(e.target.value)} /></Field>
        <Field label="Emergency contact"><Input value={ec} onChange={e => setEc(e.target.value)} /></Field>
        <div><Button onClick={() => act(A.updateOwnContact(persona, { phone, emergencyContact: ec }))}>Save changes</Button></div>
      </div>
    </GlassCard>
  )
}

export function SosModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { persona } = useCtx()
  const act = useAct()
  const [text, setText] = useState('')
  return (
    <Modal open={open} onClose={onClose} title="Send an SOS" subtitle="Goes to on-duty Security and the accommodation emergency contact. It never waits for approval."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="danger" icon="siren" onClick={() => act(A.raiseSOS(persona, text || 'SOS from resident'), () => { setText(''); onClose() })}>Send SOS</Button></>}>
      <Field label="What’s happening?" hint="Optional. Sending is enough." optional><Textarea value={text} onChange={e => setText(e.target.value)} /></Field>
      <Alert tone="warning" title="If the app is unreachable, call the front desk" detail="Phone and physical fallback is always available. The app can’t guarantee delivery during a network outage." />
    </Modal>
  )
}
