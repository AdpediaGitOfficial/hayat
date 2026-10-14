import { useState } from 'react'
import { useAct, useCtx } from '../ctx'
import { A } from '../domain/store'
import { Alert, Badge, Blocked, Button, Check, Countdown, DataTable, Field, GlassCard, Modal, PageHeader, Person, Select, Status, Tabs } from '../ui'
import { bedById, can, staffById, suggestBeds } from '../domain/rules'
import { DAY, fmtDateTime, today } from '../domain/time'
import type { WaitlistEntry } from '../domain/types'

export function Waitlist() {
  const { s, persona, now } = useCtx()
  const act = useAct()
  const [offerFor, setOfferFor] = useState<string | null>(null)
  const [behalf, setBehalf] = useState<string | null>(null)
  const [tab, setTab] = useState<'queue' | 'closed'>('queue')
  const offers = s.offers.filter(o => o.status === 'Pending')
  const queue = [...s.waitlist].filter(w => w.status !== 'Closed').sort((a, b) => s.config.priorityCategories.indexOf(a.priority) - s.config.priorityCategories.indexOf(b.priority) || a.queueTs - b.queueTs)
  const closed = s.waitlist.filter(w => w.status === 'Closed')
  const manage = can(persona, 'waitlist.manage'), offerRight = can(persona, 'offer.manage')
  return (
    <>
      <PageHeader crumbs={['Requests']} title="Waitlist and offers" summary={`${queue.length} waiting · entry valid ${s.config.waitlistDays} days · offer window ${s.config.offerHours}h, separate from the entry`} />
      <GlassCard title="Active offers" subtitle="The offer holds the bed. Nobody else can allocate it until the offer resolves." strong flush>
        {offers.length === 0 ? <div className="tbl-empty">No active offers</div> :
          <table className="tbl stack-m"><thead><tr><th>Resident</th><th>Bed</th><th>Delivery</th><th>48h window</th><th></th></tr></thead><tbody>
            {offers.map(o => {
              const st = staffById(s, o.staffId)!, bed = bedById(s, o.bedId)!
              return (
                <tr key={o.id}>
                  <td data-h="Resident"><Person name={st.name} sub={st.dept} /></td>
                  <td data-h="Bed" className="mono">{bed.code}</td>
                  <td data-h="Delivery">{o.deliveredAt ? <><Badge tone="success">Delivered</Badge><div className="subtle body-sm">{o.deliveredVia === 'offline' ? 'Informed offline by staff' : o.deliveredVia === 'viewed' ? 'Viewed in app' : 'Email confirmed'} · {fmtDateTime(o.deliveredAt)}</div></>
                    : <><Badge tone={o.followUp ? 'warning' : 'info'}>{o.followUp ? 'Not viewed in 24h' : 'Not yet viewed'}</Badge>{o.followUp ? <div className="subtle body-sm">Reception: please inform in person or by phone</div> : <Countdown to={o.createdAt + s.config.offerFollowUpHours * 3600_000} label="to follow-up" warnBelowMs={4 * 3600_000} />}</>}</td>
                  <td data-h="48h window">{o.expiresAt ? <Countdown to={o.expiresAt} from={o.deliveredAt} /> : <span className="muted body-sm">Starts on confirmed delivery</span>}</td>
                  <td style={{ textAlign: 'right' }}>{offerRight && <div className="row" style={{ justifyContent: 'flex-end' }}>
                    {!o.deliveredAt && <Button size="sm" onClick={() => act(A.deliverOffer(persona, o.id, 'offline'))}>Informed offline</Button>}
                    <Button size="sm" onClick={() => setBehalf(o.id)}>Accept for resident</Button></div>}</td>
                </tr>
              )
            })}
          </tbody></table>}
      </GlassCard>

      <GlassCard strong flush title="Queue" subtitle="Order: priority category, then oldest valid waiting timestamp" actions={<Tabs value={tab} onChange={setTab} options={[{ id: 'queue', label: 'Active', count: queue.length }, { id: 'closed', label: 'Closed', count: closed.length }]} />}>
        <WaitTable rows={tab === 'queue' ? queue : closed} onOffer={setOfferFor} manage={manage} offerRight={offerRight} />
      </GlassCard>
      <Alert tone="info" title="Priority categories and renewal rule are open (GH-04, GH-05)" detail="Placeholder categories are configurable. Renewal keeps queue position only if done before expiry with unchanged requirements." />
      {offerFor && <OfferModal entryId={offerFor} onClose={() => setOfferFor(null)} />}
      {behalf && <BehalfModal offerId={behalf} onClose={() => setBehalf(null)} />}
    </>
  )
}

function WaitTable({ rows, onOffer, manage, offerRight }: { rows: WaitlistEntry[]; onOffer: (id: string) => void; manage: boolean; offerRight: boolean }) {
  const { s, persona } = useCtx()
  const act = useAct()
  if (rows.length === 0) return <div className="tbl-empty">Nothing here</div>
  return (
    <table className="tbl stack-m"><thead><tr><th>#</th><th>Resident</th><th>Priority</th><th>Entry validity</th><th>Declines</th><th>Status</th><th></th></tr></thead><tbody>
      {rows.map((w, i) => {
        const st = staffById(s, w.staffId)!
        return (
          <tr key={w.id}>
            <td data-h="#" className="tnum">{w.status === 'Closed' ? '·' : i + 1}</td>
            <td data-h="Resident"><Person name={st.name} sub={`${st.gender} · ${st.dept}`} /></td>
            <td data-h="Priority"><Badge outline>{w.priority.split(' (')[0]}</Badge></td>
            <td data-h="Entry validity">{w.status === 'Closed' ? <span className="muted">{w.closeReason}</span> : <Countdown to={w.expiresAt} from={w.createdAt} warnBelowMs={3 * DAY} />}</td>
            <td data-h="Declines" className="tnum">{w.declines}</td>
            <td data-h="Status"><Status s={w.status} /></td>
            <td style={{ textAlign: 'right' }}><div className="row" style={{ justifyContent: 'flex-end' }}>
              {w.status === 'Waiting' && offerRight && <Button size="sm" variant="primary" onClick={() => onOffer(w.id)}>Offer bed</Button>}
              {manage && <Button size="sm" onClick={() => act(A.renewWaitlist(persona, w.id))}>Renew</Button>}
            </div></td>
          </tr>
        )
      })}
    </tbody></table>
  )
}

function OfferModal({ entryId, onClose }: { entryId: string; onClose: () => void }) {
  const { s, persona } = useCtx()
  const act = useAct()
  const w = s.waitlist.find(x => x.id === entryId)!
  const st = staffById(s, w.staffId)!
  const beds = suggestBeds(s, st, { from: today() }, persona.sites).filter(b => b.state === 'Available' && !w.skipBeds.includes(b.id))
  const [bed, setBed] = useState(beds[0]?.id ?? '')
  return (
    <Modal open onClose={onClose} title={`Offer a bed to ${st.name}`} subtitle="One active offer per resident. The bed is held while the offer is open."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!bed} onClick={() => act(A.makeOffer(persona, w.id, bed), onClose)}>Send offer</Button></>}>
      {beds.length === 0 ? <Blocked why="No eligible Available bed right now" owner="Housekeeping" next="Beds needing cleaning can’t be offered until they pass final inspection" /> :
        <Field label="Bed"><Select value={bed} onChange={e => setBed(e.target.value)}>{beds.map(b => <option key={b.id} value={b.id}>{b.code}</option>)}</Select></Field>}
      <Alert tone="info" title="The 48h clock starts on confirmed delivery" detail="When the resident views the offer in the app, confirms the email, or staff record that they informed them offline." />
    </Modal>
  )
}

function BehalfModal({ offerId, onClose }: { offerId: string; onClose: () => void }) {
  const { s, persona } = useCtx()
  const act = useAct()
  const o = s.offers.find(x => x.id === offerId)!
  const [consent, setConsent] = useState(false)
  return (
    <Modal open onClose={onClose} title={`Accept for ${staffById(s, o.staffId)?.name}`} subtitle="Allowed with the resident’s consent. Recorded and audited."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={() => act(A.acceptOffer(persona, o.id, consent), onClose)}>Accept offer</Button></>}>
      <Check checked={consent} onChange={setConsent}>The resident has agreed (in person or by phone) for me to accept on their behalf</Check>
    </Modal>
  )
}
