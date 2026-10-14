import { useState } from 'react'
import { useAct, useCtx } from '../ctx'
import { A } from '../domain/store'
import { Alert, Badge, Button, Check, DataTable, Field, GlassCard, Input, Modal, PageHeader, Person, Select, Status, Tabs, Textarea } from '../ui'
import { activeStayOfStaff, bedById, can, roomOf, staffById } from '../domain/rules'
import { dateStr, fmtTime } from '../domain/time'
import type { Visitor } from '../domain/types'

const stamp = (day: string, hhmm: string) => Date.parse(`${day}T${hhmm}:00Z`)

export function Visitors() {
  const { s, persona, now } = useCtx()
  const act = useAct()
  const [tab, setTab] = useState<'today' | 'all'>('today')
  const [add, setAdd] = useState(false)
  const [gate, setGate] = useState<Visitor | null>(null)
  const [denyFor, setDenyFor] = useState<Visitor | null>(null)
  const T = dateStr(now)
  const rows = s.visitors.filter(v => tab === 'all' || dateStr(v.from) === T).sort((a, b) => a.from - b.from)
  const isGate = can(persona, 'visitor.gate'), canReg = can(persona, 'visitor.register'), canApprove = can(persona, 'visitor.approve')
  const h = s.config.visitorHours
  return (
    <>
      <PageHeader crumbs={['Operations']} title="Visitors" summary={`Pre-register → approve → identity check → gate in → gate out. Hours ${h.open}–${h.close}${s.config.visitorOvernight ? '' : ', no overnight'} (placeholder until GH-10 is answered).`}
        actions={<>{canReg && <Button variant="primary" icon="plus" onClick={() => setAdd(true)}>Register visitor</Button>}<Tabs value={tab} onChange={setTab} options={[{ id: 'today', label: 'Today' }, { id: 'all', label: 'All' }]} /></>} />
      {isGate && <Alert tone="info" title="Gate view" detail="You see the visitor, the host's name and room, and the approved window. Nothing else about the resident." />}
      <DataTable rowKey={v => v.id} rows={rows} empty="No visitors" cols={[
        { key: 'n', header: 'Visitor', render: v => <Person name={v.name} sub={v.purpose} /> },
        { key: 'h', header: 'Host', render: v => { const host = staffById(s, v.hostStaffId)!, st = activeStayOfStaff(s, host.id), bed = st ? bedById(s, st.bedId) : undefined; return <Person name={host.name} sub={bed ? roomOf(s, bed).name : ''} /> } },
        { key: 'w', header: 'Window', render: v => <span className="tnum">{fmtTime(v.from)}–{fmtTime(v.to)}</span> },
        { key: 's', header: 'Status', render: v => v.status === 'Checked in' && now > v.to ? <Badge tone="danger">Overstay</Badge> : <Status s={v.status} /> },
        { key: 'a', header: '', align: 'r', render: v => <div className="row" style={{ justifyContent: 'flex-end' }}>
          {canApprove && ['Pre-registered', 'Walk-in pending'].includes(v.status) && <><Button size="sm" variant="primary" onClick={() => act(A.approveVisitor(persona, v.id))}>Approve</Button><Button size="sm" variant="danger" onClick={() => setDenyFor(v)}>Deny</Button></>}
          {isGate && v.status === 'Approved' && <Button size="sm" variant="primary" onClick={() => setGate(v)}>Gate in</Button>}
          {isGate && v.status === 'Checked in' && <Button size="sm" onClick={() => act(A.visitorGateOut(persona, v.id))}>Gate out</Button>}
        </div> },
      ]} />
      {add && <AddVisitor onClose={() => setAdd(false)} />}
      {gate && <GateIn v={gate} onClose={() => setGate(null)} />}
      {denyFor && <DenyModal v={denyFor} onClose={() => setDenyFor(null)} />}
    </>
  )
}

function AddVisitor({ onClose }: { onClose: () => void }) {
  const { s, persona, now } = useCtx()
  const act = useAct()
  const hosts = s.staff.filter(x => x.status === 'Active' && activeStayOfStaff(s, x.id))
  const [host, setHost] = useState(hosts[0]?.id ?? '')
  const [name, setName] = useState(''), [purpose, setPurpose] = useState('')
  const [from, setFrom] = useState('14:00'), [to, setTo] = useState('16:00'), [walkIn, setWalkIn] = useState(false)
  const T = dateStr(now)
  const siteOf = (id: string) => { const st = activeStayOfStaff(s, id); return st ? bedById(s, st.bedId)!.siteId : 'PV' }
  return (
    <Modal open onClose={onClose} title="Register a visitor" subtitle="The host must be a current resident"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={() => act(A.registerVisitor(persona, { name, hostStaffId: host, purpose, siteId: siteOf(host), from: stamp(T, from), to: stamp(T, to), walkIn }), onClose)}>Register</Button></>}>
      <Field label="Visitor full name"><Input value={name} onChange={e => setName(e.target.value)} /></Field>
      <Field label="Host (resident)"><Select value={host} onChange={e => setHost(e.target.value)}>{hosts.slice(0, 80).map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</Select></Field>
      <Field label="Purpose"><Input value={purpose} onChange={e => setPurpose(e.target.value)} /></Field>
      <div className="grid even"><Field label="From"><Input type="time" value={from} onChange={e => setFrom(e.target.value)} /></Field><Field label="To"><Input type="time" value={to} onChange={e => setTo(e.target.value)} /></Field></div>
      <Check checked={walkIn} onChange={setWalkIn}>Walk-in (arrived without pre-registration). Needs host confirmation before entry</Check>
    </Modal>
  )
}
function GateIn({ v, onClose }: { v: Visitor; onClose: () => void }) {
  const { persona } = useCtx()
  const act = useAct()
  const [id, setId] = useState(false)
  return (
    <Modal open onClose={onClose} title={`Gate in: ${v.name}`} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={() => act(A.visitorGateIn(persona, v.id, { idChecked: id }), onClose)}>Record entry</Button></>}>
      <Check checked={id} onChange={setId}>I checked the visitor's identity</Check>
    </Modal>
  )
}
function DenyModal({ v, onClose }: { v: Visitor; onClose: () => void }) {
  const { persona } = useCtx()
  const act = useAct()
  const [r, setR] = useState('')
  return (
    <Modal open onClose={onClose} title={`Deny ${v.name}`} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="danger" onClick={() => act(A.denyVisitor(persona, v.id, r), onClose)}>Deny</Button></>}>
      <Field label="Reason"><Textarea value={r} onChange={e => setR(e.target.value)} /></Field>
    </Modal>
  )
}
