import { useState } from 'react'
import { useAct, useCtx } from '../ctx'
import { A } from '../domain/store'
import { Alert, Button, Field, GlassCard, Input, PageHeader, Select, Textarea } from '../ui'
import { bedConflict, can, eligibility } from '../domain/rules'
import { addDays, today } from '../domain/time'
import type { StayType } from '../domain/types'

export function RequestBed() {
  const { s, persona, now, go } = useCtx()
  const act = useAct()
  const T = today(now)
  const onBehalf = persona.role !== 'Res'
  const candidates = s.staff.filter(x => x.status === 'Active' && !s.stays.some(st => st.staffId === x.id && st.status === 'Active') && !s.reservations.some(r => r.staffId === x.id && r.status === 'Reserved') && !s.requests.some(r => r.staffId === x.id && r.status === 'Submitted') && !s.waitlist.some(w => w.staffId === x.id && w.status !== 'Closed'))
  const [staffId, setStaffId] = useState(onBehalf ? candidates[0]?.id ?? '' : persona.staffId!)
  const [arrival, setArrival] = useState(addDays(T, 5))
  const [end, setEnd] = useState(addDays(T, 185))
  const [type, setType] = useState<StayType>('Permanent')
  const [note, setNote] = useState('')
  const staff = s.staff.find(x => x.id === staffId)
  const free = staff ? s.beds.filter(b => ['Available', 'NeedsCleaning', 'InspectionRequired', 'Occupied'].includes(b.state) && eligibility(s, staff, b).ok && !bedConflict(s, b.id, { from: arrival, to: end })).length : 0
  const submit = () => act(A.submitRequest(persona, { staffId, arrival, end, stayType: type, note }), () => go('dashboard'))
  return (
    <>
      <PageHeader title={onBehalf ? 'New request for staff' : 'Request a bed'} summary={onBehalf ? 'Submit on behalf of a staff member. They are notified and the request is audited.' : 'Tell us when you’d like to move in and for how long.'} />
      <GlassCard strong>
        <div className="stack" style={{ maxWidth: 560 }}>
          {onBehalf && <Field label="Staff member"><Select value={staffId} onChange={e => setStaffId(e.target.value)}>{candidates.map(x => <option key={x.id} value={x.id}>{x.name} · {x.id}</option>)}</Select></Field>}
          <div className="grid even">
            <Field label="Arrival date"><Input type="date" value={arrival} min={T} onChange={e => setArrival(e.target.value)} /></Field>
            <Field label="Planned end date" hint="Required for standard stays"><Input type="date" value={end} min={arrival} onChange={e => setEnd(e.target.value)} invalid={!end} /></Field>
          </div>
          <Field label="Stay type"><Select value={type} onChange={e => setType(e.target.value as StayType)}><option>Permanent</option><option>Contract</option><option>Trainee</option></Select></Field>
          <Field label="Note" optional><Textarea value={note} onChange={e => setNote(e.target.value)} /></Field>
          {staff && (free > 0
            ? <Alert tone="success" title={`${free} eligible beds look free for these dates`} detail="The Accommodation Admin picks the bed when approving." />
            : <Alert tone="warning" title="No eligible bed is free for these dates" detail="You can still submit. The admin may put you on the waitlist (valid 15 days)." />)}
          <div className="row"><Button variant="primary" onClick={submit}>Submit request</Button><Button variant="ghost" onClick={() => go('dashboard')}>Cancel</Button></div>
        </div>
      </GlassCard>
    </>
  )
}
