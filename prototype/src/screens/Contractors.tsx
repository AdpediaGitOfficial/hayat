import { useState } from 'react'
import { useAct, useCtx } from '../ctx'
import { A } from '../domain/store'
import { Badge, Blocked, Button, DataTable, Field, GlassCard, Input, Modal, PageHeader, Select, Status, Tabs, Textarea } from '../ui'
import { can } from '../domain/rules'
import { visitProblems } from '../domain/ext/security'
import { dateStr, fmtDate, fmtTime } from '../domain/time'
import type { ContractorVisit } from '../domain/types'

export function Contractors() {
  const { s, persona, now } = useCtx()
  const act = useAct()
  const [tab, setTab] = useState<'visits' | 'contracts'>('visits')
  const [add, setAdd] = useState(false)
  const [revoke, setRevoke] = useState<ContractorVisit | null>(null)
  const manage = can(persona, 'contractor.manage'), gate = can(persona, 'contractor.gate')
  const vendorName = (id: string) => s.vendors.find(v => v.id === id)?.name ?? id
  const rows = [...s.contractorVisits].sort((a, b) => a.from - b.from)
  return (
    <>
      <PageHeader crumbs={['Operations']} title={gate && !manage ? 'Contractor gate' : 'Contractors'}
        summary="Access is valid only inside contract + documents + job + visit window, and every condition is re-checked at the gate."
        actions={<>{manage && <Button variant="primary" icon="plus" onClick={() => setAdd(true)}>Schedule visit</Button>}<Tabs value={tab} onChange={setTab} options={[{ id: 'visits', label: 'Visits', count: rows.length }, { id: 'contracts', label: 'Contracts' }]} /></>} />
      {tab === 'visits' && <div className="stack">
        {rows.map(v => {
          const problems = visitProblems(s, v, now)
          const onSite = v.status === 'Checked in'
          const wo = s.workOrders.find(w => w.id === v.workOrderId)
          return (
            <GlassCard key={v.id} strong title={vendorName(v.vendorId)} subtitle={`${wo?.title ?? ''} · ${fmtDate(v.from)} ${fmtTime(v.from)}–${fmtTime(v.to)}`}
              actions={<Status s={v.status} />}>
              <div className="stack">
                <div className="chips">
                  {(['contract', 'documents', 'job', 'window'] as const).map(k => {
                    const bad = problems.find(p => k === 'contract' ? /Contract|contract/.test(p) : k === 'documents' ? /documents/.test(p) : k === 'job' ? /Job|job/.test(p) : /window/.test(p))
                    return <Badge key={k} tone={bad ? 'danger' : 'success'}>{k}: {bad ? 'fails' : 'ok'}</Badge>
                  })}
                  <Badge outline>Workers: {v.workers.join(', ')}</Badge>{v.escort && <Badge outline>Escort: {v.escort}</Badge>}
                </div>
                {v.status === 'Denied' && <Blocked why={`Access denied: ${v.denyReason}`} owner="Maintenance Coordinator" next="Resolve the prerequisite and reschedule" />}
                {v.status === 'Revoked' && v.checkedInAt && !v.checkedOutAt && <Blocked why="Access revoked while on site" owner="Security" next="Escort them out, then record gate-out" />}
                {problems.length > 0 && !['Denied', 'Checked out', 'Revoked'].includes(v.status) && <div className="muted body-sm">Right now: {problems.join('; ')}</div>}
                <div className="row wrap">
                  {manage && v.status === 'Scheduled' && <Button size="sm" onClick={() => act(A.issueGatePass(persona, v.id))}>Issue gate pass</Button>}
                  {gate && v.status !== 'Checked out' && v.status !== 'Denied' && !onSite && !(v.status === 'Revoked' && v.checkedInAt) && <Button size="sm" variant="primary" onClick={() => act(A.contractorGateIn(persona, v.id))}>Gate in</Button>}
                  {gate && (onSite || (v.status === 'Revoked' && v.checkedInAt && !v.checkedOutAt)) && <Button size="sm" onClick={() => act(A.contractorGateOut(persona, v.id))}>Gate out</Button>}
                  {manage && ['Scheduled', 'Gate pass valid', 'Checked in'].includes(v.status) && <Button size="sm" variant="danger" onClick={() => setRevoke(v)}>Revoke</Button>}
                </div>
              </div>
            </GlassCard>
          )
        })}
      </div>}
      {tab === 'contracts' && <DataTable rowKey={c => c.id} rows={s.contracts} cols={[
        { key: 'v', header: 'Vendor', render: c => vendorName(c.vendorId) },
        { key: 'p', header: 'Contract period', render: c => <span className="tnum">{fmtDate(c.from)} → {fmtDate(c.to)}</span> },
        { key: 'd', header: 'Worker documents valid until', render: c => <span className={c.docsValidUntil < dateStr(now) ? 'cd over' : 'tnum'}>{fmtDate(c.docsValidUntil)}{c.docsValidUntil < dateStr(now) ? ' (expired)' : ''}</span> },
        { key: 's', header: 'Status', render: c => <Badge tone={c.status === 'Active' ? 'success' : 'danger'}>{c.status}</Badge> },
        { key: 'a', header: '', align: 'r', render: c => manage ? <div className="row" style={{ justifyContent: 'flex-end' }}>
          {c.status === 'Active' ? <Button size="sm" variant="danger" onClick={() => act(A.setContractStatus(persona, c.id, 'Suspended', 'Suspended pending review'))}>Suspend</Button> : <Button size="sm" onClick={() => act(A.setContractStatus(persona, c.id, 'Active', 'Reinstated'))}>Reinstate</Button>}</div> : null },
      ]} />}
      {add && <ScheduleModal onClose={() => setAdd(false)} />}
      {revoke && <RevokeModal v={revoke} onClose={() => setRevoke(null)} />}
    </>
  )
}
function ScheduleModal({ onClose }: { onClose: () => void }) {
  const { s, persona, now } = useCtx()
  const act = useAct()
  const [vendorId, setVendorId] = useState(s.vendors[0].id)
  const jobs = s.workOrders.filter(w => w.assignee === s.vendors.find(v => v.id === vendorId)?.name && w.status !== 'Verified')
  const [job, setJob] = useState('')
  const T = dateStr(now)
  const [day, setDay] = useState(T), [from, setFrom] = useState('09:00'), [to, setTo] = useState('17:00')
  const [workers, setWorkers] = useState(''), [escort, setEscort] = useState('')
  return (
    <Modal open onClose={onClose} title="Schedule a contractor visit"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={() => act(A.scheduleContractorVisit(persona, { vendorId, workOrderId: job || jobs[0]?.id, from: Date.parse(`${day}T${from}:00Z`), to: Date.parse(`${day}T${to}:00Z`), workers: workers.split(',').map(x => x.trim()).filter(Boolean), escort: escort || undefined }), onClose)}>Schedule</Button></>}>
      <Field label="Vendor"><Select value={vendorId} onChange={e => { setVendorId(e.target.value); setJob('') }}>{s.vendors.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}</Select></Field>
      <Field label="Assigned job"><Select value={job || jobs[0]?.id} onChange={e => setJob(e.target.value)}>{jobs.map(w => <option key={w.id} value={w.id}>{w.title}</option>)}</Select></Field>
      <div className="grid three"><Field label="Date"><Input type="date" value={day} onChange={e => setDay(e.target.value)} /></Field><Field label="From"><Input type="time" value={from} onChange={e => setFrom(e.target.value)} /></Field><Field label="To"><Input type="time" value={to} onChange={e => setTo(e.target.value)} /></Field></div>
      <Field label="Workers" hint="Comma separated"><Input value={workers} onChange={e => setWorkers(e.target.value)} /></Field>
      <Field label="Escort" optional><Input value={escort} onChange={e => setEscort(e.target.value)} /></Field>
    </Modal>
  )
}
function RevokeModal({ v, onClose }: { v: ContractorVisit; onClose: () => void }) {
  const { persona } = useCtx()
  const act = useAct()
  const [r, setR] = useState('')
  return (
    <Modal open onClose={onClose} title="Revoke this visit" subtitle={v.status === 'Checked in' ? 'They are on site: Security is alerted to escort them out' : undefined}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="danger" onClick={() => act(A.revokeContractorVisit(persona, v.id, r), onClose)}>Revoke</Button></>}>
      <Field label="Reason"><Textarea value={r} onChange={e => setR(e.target.value)} /></Field>
    </Modal>
  )
}
