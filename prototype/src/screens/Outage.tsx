import { useState } from 'react'
import { useAct, useCtx } from '../ctx'
import { A } from '../domain/store'
import { Alert, Badge, Blocked, Button, DataTable, Field, GlassCard, Input, Modal, PageHeader, Person, Select, Stepper, Textarea } from '../ui'
import { can, staffById } from '../domain/rules'
import { fmtDateTime } from '../domain/time'
import type { OfflineEvent } from '../domain/types'

export function Outage() {
  const { s, persona, now } = useCtx()
  const act = useAct()
  const [log, setLog] = useState(false)
  const [review, setReview] = useState<{ ev: OfflineEvent; decision: 'apply' | 'dismiss' } | null>(null)
  const o = s.outage
  const phase = !o ? 0 : o.restoredAt ? 3 : 1
  const canExport = can(persona, 'outage.export'), canDeclare = can(persona, 'outage.declare') || canExport, canReconcile = can(persona, 'outage.reconcile')
  const download = () => act(A.exportOutageSnapshot(persona), r => {
    const blob = new Blob([r.data as string], { type: 'text/csv' })
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'outage-snapshot.csv'; a.click()
  })
  const open = s.offlineEvents.filter(e => e.status === 'Pending review' || e.status === 'Conflict')
  return (
    <>
      <PageHeader crumbs={['Operations']} title="Outage mode" summary="Network-only outage. The snapshot is reference data and never reserves a bed; offline actions are validated before they touch live records." />
      <GlassCard strong title="Where we are" subtitle={o ? (o.restoredAt ? `Restored ${fmtDateTime(o.restoredAt)}` : `Declared ${fmtDateTime(o.declaredAt)} by ${o.declaredBy}`) : 'No outage declared'}>
        <div className="stack">
          <Stepper steps={['Export snapshot', 'Outage: paper log', 'Service restored', 'Reconcile']} current={!o ? 0 : !o.restoredAt ? 1 : open.length ? 3 : 4} />
          <div className="row wrap">
            <Button icon="download" onClick={download} disabled={!canExport}>Export snapshot</Button>
            {!o || o.restoredAt ? <Button variant="danger" onClick={() => act(A.declareOutage(persona))} disabled={!canDeclare}>Declare outage</Button> : <Button variant="primary" onClick={() => act(A.restoreService(persona))} disabled={!canDeclare}>Service restored</Button>}
            {o && <Button onClick={() => setLog(true)} disabled={!canExport && !canReconcile}>Enter offline log entry</Button>}
          </div>
          {!canExport && <Blocked why="Exporting the snapshot needs the Outage Export capability" owner="Super Admin (maker-checker grant)" next="Switch to Rohan Das (Reception)" />}
          <p className="muted body-sm">Phase 1 does not support offline bed allocation: use the paper log, and urgent arrivals follow the approved procedure (owner still to be named, GH-12).</p>
        </div>
      </GlassCard>
      <DataTable rowKey={e => e.id} rows={s.offlineEvents} empty="No offline events logged"
        toolbar={<span className="muted">Offline events, reconciled one by one against live records</span>}
        cols={[
          { key: 'k', header: 'Event', render: e => <Badge outline>{e.kind}</Badge> },
          { key: 'p', header: 'Person', render: e => <Person name={staffById(s, e.staffId)?.name ?? e.staffId} sub={e.bedCode} /> },
          { key: 'a', header: 'When', render: e => <span className="tnum">{fmtDateTime(e.at)}</span> },
          { key: 's', header: 'Result', render: e => e.status === 'Conflict' ? <div><Badge tone="danger">Conflict</Badge><div className="subtle body-sm" style={{ maxWidth: 280 }}>{e.conflict}</div></div> : <Badge tone={e.status === 'Applied' ? 'success' : e.status === 'Dismissed' ? 'neutral' : 'brand'}>{e.status}</Badge> },
          { key: 'x', header: '', align: 'r', render: e => canReconcile && (e.status === 'Pending review' || e.status === 'Conflict') ? <div className="row" style={{ justifyContent: 'flex-end' }}>
            <Button size="sm" variant="primary" disabled={!o?.restoredAt} onClick={() => act(A.reconcileOffline(persona, e.id, 'apply', ''))}>Apply</Button><Button size="sm" onClick={() => setReview({ ev: e, decision: 'dismiss' })}>Dismiss</Button></div> : e.reviewedBy ? <span className="subtle body-sm">{e.reviewedBy}</span> : null },
        ]} />
      {!canReconcile && s.offlineEvents.length > 0 && <Alert tone="info" title="Reconciliation is done by an Accommodation Admin" detail="Owner to be confirmed by Grand Hyatt (GH-12)." />}
      {log && <LogModal onClose={() => setLog(false)} />}
      {review && <DismissModal ev={review.ev} onClose={() => setReview(null)} />}
    </>
  )
}
function LogModal({ onClose }: { onClose: () => void }) {
  const { s, persona, now } = useCtx()
  const act = useAct()
  const [kind, setKind] = useState<'arrival' | 'departure'>('arrival')
  const people = s.staff.filter(x => x.status === 'Active').slice(0, 300)
  const [staffId, setStaffId] = useState('E1012')
  const [bedCode, setBedCode] = useState('PV-V05-R1-A')
  const [time, setTime] = useState('10:00')
  return (
    <Modal open onClose={onClose} title="Offline log entry" subtitle="Copy from the paper log. We check it against live records straight away."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={() => act(A.logOfflineEvent(persona, { kind, staffId, bedCode, at: Date.parse(`${new Date(now).toISOString().slice(0, 10)}T${time}:00Z`) }), onClose)}>Log</Button></>}>
      <Field label="Event"><Select value={kind} onChange={e => setKind(e.target.value as 'arrival')}><option value="arrival">Arrival</option><option value="departure">Departure</option></Select></Field>
      <Field label="Person"><Select value={staffId} onChange={e => setStaffId(e.target.value)}>{people.map(x => <option key={x.id} value={x.id}>{x.name} · {x.id}</option>)}</Select></Field>
      <div className="grid even"><Field label="Bed code"><Input value={bedCode} onChange={e => setBedCode(e.target.value)} /></Field><Field label="Time"><Input type="time" value={time} onChange={e => setTime(e.target.value)} /></Field></div>
    </Modal>
  )
}
function DismissModal({ ev, onClose }: { ev: OfflineEvent; onClose: () => void }) {
  const { persona } = useCtx()
  const act = useAct()
  const [n, setN] = useState('')
  return (
    <Modal open onClose={onClose} title="Dismiss this offline event" subtitle="Nothing is applied to live records"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="danger" onClick={() => act(A.reconcileOffline(persona, ev.id, 'dismiss', n), onClose)}>Dismiss</Button></>}>
      <Field label="Why"><Textarea value={n} onChange={e => setN(e.target.value)} /></Field>
    </Modal>
  )
}
