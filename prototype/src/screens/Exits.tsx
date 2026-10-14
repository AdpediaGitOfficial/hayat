import { useState } from 'react'
import { useAct, useCtx } from '../ctx'
import { A } from '../domain/store'
import { Alert, Badge, Blocked, Button, Check, DataTable, Field, GlassCard, Icon, Input, Modal, PageHeader, Person, Select, Status, Stepper, Tabs, Textarea } from '../ui'
import { activeStayOfStaff, bedById, can, isPA, staffById } from '../domain/rules'
import { addDays, fmtDate, fmtDateTime, today } from '../domain/time'

export function Exits() {
  const { s, persona, now, params, go } = useCtx()
  const act = useAct()
  const [tab, setTab] = useState<'exit' | 'checkout' | 'joiners'>(params.stay ? 'checkout' : 'exit')
  const [markFor, setMarkFor] = useState<string | null>(null)
  const [outFor, setOutFor] = useState<string | null>(params.stay ?? null)
  const T = today(now)
  const queue = s.stays.filter(x => x.status === 'Active' && (x.exitPending || x.checkoutRequested || x.end === T))
  const active = s.staff.filter(x => x.status === 'Active' && !x.archived)
  const [q, setQ] = useState('')
  const joiners = s.staff.filter(x => !x.verified || s.requests.some(r => r.staffId === x.id && r.status === 'Submitted'))
  return (
    <>
      <PageHeader crumbs={['People']} title="Joiners and exits" summary="Checkout ≠ clearance complete ≠ bed ready. An exit never frees an occupied bed by itself."
        actions={<Tabs value={tab} onChange={setTab} options={[{ id: 'exit', label: 'Mark as Left' }, { id: 'checkout', label: 'Checkout queue', count: queue.length }, { id: 'joiners', label: 'Joiners', count: joiners.length }]} />} />
      {tab === 'exit' && <DataTable rowKey={x => x.id} rows={active.filter(x => x.name.toLowerCase().includes(q.toLowerCase()) || x.id.toLowerCase().includes(q.toLowerCase())).slice(0, 25)}
        toolbar={<label className="search" style={{ margin: 0, maxWidth: 300 }}><Icon name="search" /><input placeholder="Find staff to mark as Left" value={q} onChange={e => setQ(e.target.value)} aria-label="Find staff" /></label>}
        cols={[
          { key: 'n', header: 'Staff', render: x => <Person name={x.name} sub={`${x.id} · ${x.dept}`} /> },
          { key: 's', header: 'Accommodation', render: x => { const st = activeStayOfStaff(s, x.id); return st ? <span className="mono">{bedById(s, st.bedId)?.code}</span> : <span className="muted">No stay</span> } },
          { key: 'a', header: '', align: 'r', render: x => can(persona, 'exit.markLeft') ? <Button size="sm" variant="danger" onClick={() => setMarkFor(x.id)}>Mark as Left</Button> : null },
        ]} footer={<span>Showing first 25. Search to narrow.</span>} />}
      {tab === 'checkout' && <DataTable rowKey={x => x.id} rows={queue} empty="No checkouts waiting" cols={[
        { key: 'n', header: 'Resident', render: x => { const st = staffById(s, x.staffId)!; return <Person name={st.name} sub={st.dept} /> } },
        { key: 'b', header: 'Bed', render: x => <span className="mono">{bedById(s, x.bedId)?.code}</span> },
        { key: 'w', header: 'Why', render: x => x.exitPending ? <Badge tone="neutral">Left organisation</Badge> : x.checkoutRequested ? <Badge tone="warning">Voluntary: no approval needed</Badge> : <Badge tone="warning">Planned end today</Badge> },
        { key: 'a', header: '', align: 'r', render: x => can(persona, 'checkout.execute') ? <Button size="sm" variant="primary" onClick={() => setOutFor(x.id)}>Process checkout</Button> : null },
      ]} />}
      {tab === 'joiners' && <DataTable rowKey={x => x.id} rows={joiners} empty="No joiners waiting" cols={[
        { key: 'n', header: 'Staff', render: x => <Person name={x.name} sub={`${x.id} · ${x.dept}`} /> },
        { key: 'v', header: 'Profile', render: x => x.verified ? <Badge tone="success">Verified</Badge> : <Badge tone="warning">Unverified</Badge> },
        { key: 'q', header: 'Request', render: x => s.requests.some(r => r.staffId === x.id && r.status === 'Submitted') ? <Badge tone="brand">Open request</Badge> : <span className="muted">None</span> },
        { key: 'a', header: '', align: 'r', render: x => <div className="row" style={{ justifyContent: 'flex-end' }}>{!x.verified && <Button size="sm" onClick={() => act(A.verifyStaff(persona, x.id))}>Verify</Button>}<Button size="sm" variant="ghost" onClick={() => go('approvals')}>Requests</Button></div> },
      ]} />}
      {markFor && <MarkLeftModal staffId={markFor} onClose={() => setMarkFor(null)} />}
      {outFor && <CheckoutModal stayId={outFor} onClose={() => setOutFor(null)} />}
    </>
  )
}

function MarkLeftModal({ staffId, onClose }: { staffId: string; onClose: () => void }) {
  const { s, persona, now } = useCtx()
  const act = useAct()
  const staff = staffById(s, staffId)!
  const stay = activeStayOfStaff(s, staffId)
  const [eff, setEff] = useState(today(now))
  const [reason, setReason] = useState('Resigned')
  const [confirm, setConfirm] = useState(false)
  return (
    <Modal open onClose={onClose} title={`Mark ${staff.name} as Left`} subtitle="High-risk action: login is revoked immediately"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="danger" onClick={() => act(A.markLeft(persona, staffId, { effective: eff, reason, confirm }), onClose)}>Mark as Left</Button></>}>
      <Alert tone="warning" title="What happens now" detail={`Login deactivated and sessions invalidated. Waitlist entries closed, open offers withdrawn, future reservations cancelled. ${stay ? `A clearance case opens, but ${bedById(s, stay.bedId)?.code} stays Occupied until actual checkout.` : 'No active stay, so nothing to clear.'} The Policy Approver is notified.`} />
      <div className="grid even"><Field label="Effective date"><Input type="date" value={eff} onChange={e => setEff(e.target.value)} /></Field><Field label="Reason"><Select value={reason} onChange={e => setReason(e.target.value)}><option>Resigned</option><option>Terminated</option><option>End of contract</option><option>Transferred out</option></Select></Field></div>
      <Check checked={confirm} onChange={setConfirm}>I confirm with my password (re-confirmation on high-risk actions)</Check>
    </Modal>
  )
}

export function CheckoutModal({ stayId, onClose }: { stayId: string; onClose: () => void }) {
  const { s, persona } = useCtx()
  const act = useAct()
  const st = s.stays.find(x => x.id === stayId)!
  const bed = bedById(s, st.bedId)!
  const [keys, setKeys] = useState(true)
  return (
    <Modal open onClose={onClose} title={`Check out ${staffById(s, st.staffId)?.name}`} subtitle={bed.code}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={() => act(A.checkout(persona, stayId, { keysReturned: keys }), onClose)}>Complete checkout</Button></>}>
      <Check checked={keys} onChange={setKeys}>Keys returned</Check>
      <Alert tone="info" title={`${bed.code} will become Needs cleaning, not Available`} detail="Checkout is not clearance and it is not bed readiness. The bed becomes Available only after cleaning and final inspection by someone else." />
    </Modal>
  )
}

/* ============ Clearances ============ */
export function Clearances() {
  const { s, persona } = useCtx()
  const act = useAct()
  const [tab, setTab] = useState<'Open' | 'Closed'>('Open')
  const cases = s.clearances.filter(c => c.status === tab)
  return (
    <>
      <PageHeader crumbs={['People']} title="Clearances" summary="The case stays open after the login is gone. Admins act on the resident’s behalf, attributed in the audit log."
        actions={<Tabs value={tab} onChange={setTab} options={[{ id: 'Open', label: 'Open', count: s.clearances.filter(c => c.status === 'Open').length }, { id: 'Closed', label: 'Closed' }]} />} />
      {cases.length === 0 && <GlassCard><div className="tbl-empty">No {tab.toLowerCase()} clearance cases</div></GlassCard>}
      {cases.map(c => <CaseCard key={c.id} id={c.id} />)}
    </>
  )
}

function CaseCard({ id }: { id: string }) {
  const { s, persona } = useCtx()
  const act = useAct()
  const c = s.clearances.find(x => x.id === id)!
  const staff = staffById(s, c.staffId)!
  const stay = c.stayId ? s.stays.find(x => x.id === c.stayId) : undefined
  const bed = stay ? bedById(s, stay.bedId) : undefined
  const [wr, setWr] = useState(''), [ev, setEv] = useState(''), [showW, setShowW] = useState(false)
  const open = c.items.filter(i => i.mandatory && i.status === 'Open')
  // bed journey: Left → Checkout → Clearance → Cleaning → Inspection → Available
  const bedStep = !bed ? 0 : stay!.status === 'Active' ? 1 : bed.state === 'NeedsCleaning' ? 3 : bed.state === 'InspectionRequired' ? 4 : bed.state === 'Available' || bed.state === 'Occupied' ? 5 : 2
  return (
    <GlassCard strong title={`${staff.name} · ${staff.id}`} subtitle={`Left ${fmtDate(c.effective)} · ${c.reason}${bed ? ' · ' + bed.code : ''}`} actions={<Status s={c.status === 'Open' ? 'Open' : 'Done'} label={c.status} />}>
      <div className="stack">
        {bed && <Stepper steps={['Marked as Left', 'Checkout', 'Clearance', 'Cleaning', 'Inspection', 'Available']} current={bedStep === 0 ? 0 : Math.min(bedStep, 5)} />}
        {stay?.status === 'Active' && <Blocked why={`${bed!.code} is still Occupied`} owner="Reception" next="Process checkout in Joiners and exits. The bed isn't freed until the resident actually leaves" />}
        <ul className="list-plain">
          {c.items.map(i => (
            <li key={i.id}>
              <input type="checkbox" aria-label={i.label} checked={i.status !== 'Open'} disabled={c.status === 'Closed' || i.status === 'Waived'} onChange={e => act(A.setClearanceItem(persona, c.id, i.id, e.target.checked))} />
              <span style={{ flex: 1 }}>{i.label}{!i.mandatory && <span className="subtle"> (optional)</span>}</span>
              <Badge outline>{i.owner}</Badge>{i.status === 'Waived' && <Badge tone="info">Waived</Badge>}
            </li>
          ))}
        </ul>
        {c.waiver && <Alert tone="info" title={`Waived by ${c.waiver.by}`} detail={`${c.waiver.reason} · evidence: ${c.waiver.evidence}`} />}
        {c.status === 'Open' && (
          <>
            {showW && <div className="grid even"><Field label="Waiver reason"><Input value={wr} onChange={e => setWr(e.target.value)} /></Field><Field label="Evidence (reference)"><Input value={ev} onChange={e => setEv(e.target.value)} /></Field></div>}
            <div className="row wrap">
              <Button variant="primary" onClick={() => act(A.closeClearance(persona, c.id))}>Close case</Button>
              {open.length > 0 && isPA(persona) && <Button onClick={() => { if (!showW) setShowW(true); else act(A.waiveClearance(persona, c.id, wr, ev)) }}>{showW ? 'Confirm waiver' : 'Waive mandatory items'}</Button>}
              {open.length > 0 && !isPA(persona) && <span className="muted body-sm">Mandatory items open: only the Policy Approver can waive (reason + evidence).</span>}
            </div>
          </>
        )}
      </div>
    </GlassCard>
  )
}
