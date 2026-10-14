import { useState } from 'react'
import { useAct, useCtx } from '../ctx'
import { A } from '../domain/store'
import { Alert, Badge, Blocked, Button, Check, Countdown, Field, GlassCard, PageHeader, Person, Select, Status, Textarea } from '../ui'
import { approvalInbox } from '../domain/select'
import { bedById, can, staffById } from '../domain/rules'
import { fmtDateTime } from '../domain/time'
import { ApprovalCard } from './Approvals'

export function Emergency() {
  const { s, persona, now } = useCtx()
  const act = useAct()
  const canInit = can(persona, 'emergency.initiate')
  const people = s.staff.filter(x => x.status === 'Active' && !s.stays.some(st => st.staffId === x.id && st.status === 'Active') && x.id !== persona.staffId)
  const [staffId, setStaffId] = useState(people[0]?.id ?? '')
  const staff = staffById(s, staffId)
  const beds = s.beds.filter(b => b.state === 'Available' && !b.heldBy && !s.reservations.some(r => r.bedId === b.id && r.status === 'Reserved') && (!staff || s.rooms.find(r => r.id === b.roomId)!.gender === 'Any' || s.rooms.find(r => r.id === b.roomId)!.gender === staff.gender))
  const [bedId, setBedId] = useState('')
  const [reason, setReason] = useState('')
  const [confirm, setConfirm] = useState(false)
  const pending = approvalInbox(s, persona, now).filter(i => i.kind === 'Emergency')
  const history = s.emergencies.filter(m => m.status !== 'Pending')
  const tasks = s.tasks.filter(t => !t.done)
  const route = persona.role === 'AA' ? 'Policy Approver (you are an AA, so you can’t approve your own)' : 'Accommodation Admin'
  return (
    <>
      <PageHeader crumbs={['Operations']} title="Emergency check-in" summary="A provisional stay with a 24h decision deadline. Re-alerts every 24h and escalates after two unanswered. Never auto-approved, never auto-checked-out." />
      <Alert tone="info" title="Watch it escalate" detail="Use the demo clock below (+1 day, +1 day) to see reminders fire and the route move to the backup approver, then the Policy Approver." />
      <div className="grid two" style={{ gridTemplateColumns: '1fr 380px' }}>
        <div className="stack">
          {pending.length === 0 && <GlassCard><div className="tbl-empty">No emergency check-ins waiting for a decision</div></GlassCard>}
          {pending.map(i => <ApprovalCard key={i.key} item={i} onOpen={() => {}} />)}
          {tasks.length > 0 && <GlassCard title="Relocation tasks" subtitle="From rejected provisional stays. The resident is never moved automatically." strong flush>
            {tasks.map(t => <div key={t.id} className="approval-card" style={{ borderTop: '1px solid var(--line)' }}><b>{t.title}</b><div className="row"><Countdown to={t.due} label="deadline" warnBelowMs={12 * 3600_000} /><span className="spacer" />{persona.role === 'AA' && <Button size="sm" onClick={() => act(A.completeTask(persona, t.id))}>Mark done</Button>}</div></div>)}
          </GlassCard>}
          {history.length > 0 && <GlassCard title="Decided" strong flush><ul className="list-plain" style={{ padding: '0 20px 12px' }}>{history.map(m => <li key={m.id}><Person name={staffById(s, m.staffId)!.name} sub={`${bedById(s, m.bedId)?.code} · ${m.decidedBy}${m.decisionReason ? ': ' + m.decisionReason : ''}`} /><span className="spacer" /><Status s={m.status} /></li>)}</ul></GlassCard>}
        </div>
        <GlassCard title="Initiate" subtitle="Only holders of the Emergency Check-in capability" strong>
          {!canInit ? <Blocked why={`${persona.name} doesn't hold the Emergency Check-in capability`} owner="Super Admin (maker-checker grant)" next="Switch to Rohan Das (Reception) or Anita Rao (AA)" /> : (
            <div className="stack">
              <Field label="Person"><Select value={staffId} onChange={e => { setStaffId(e.target.value); setBedId('') }}>{people.map(x => <option key={x.id} value={x.id}>{x.name} · {x.id}</option>)}</Select></Field>
              <Field label="Bed (free now)"><Select value={bedId || beds[0]?.id} onChange={e => setBedId(e.target.value)}>{beds.map(b => <option key={b.id} value={b.id}>{b.code}</option>)}</Select></Field>
              <Field label="What happened?"><Textarea value={reason} onChange={e => setReason(e.target.value)} /></Field>
              <Alert tone="info" title="Approver" detail={`Initiator ≠ approver. This goes to: ${route}.`} />
              <Check checked={confirm} onChange={setConfirm}>I confirm with my password</Check>
              <Button variant="primary" onClick={() => act(A.createEmergency(persona, { staffId, bedId: bedId || beds[0]?.id, reason, confirm }))}>Create provisional stay</Button>
            </div>
          )}
        </GlassCard>
      </div>
    </>
  )
}
