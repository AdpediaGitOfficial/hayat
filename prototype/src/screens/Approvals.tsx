import { useState } from 'react'
import { useAct, useCtx } from '../ctx'
import { A } from '../domain/store'
import { Alert, Badge, Blocked, Button, Countdown, Drawer, Field, GlassCard, Icon, Input, PageHeader, Select, Status, Tabs, Textarea, Person, Modal } from '../ui'
import { approvalInbox, type ApprovalItem } from '../domain/select'
import { bedById, bedConflict, bedPath, eligibility, isPA, staffById, suggestBeds } from '../domain/rules'
import { fmtDate, fmtDateTime, fmtDur, today, addDays } from '../domain/time'
import { PERSONAS } from '../roles'

export function Approvals() {
  const { s, persona, now, params } = useCtx()
  const [tab, setTab] = useState<'mine' | 'all'>('mine')
  const [open, setOpen] = useState<string | null>(params.req ?? null)
  const all = approvalInbox(s, persona, now)
  const mine = all.filter(i => i.mine)
  const list = tab === 'mine' ? mine : all
  return (
    <>
      <PageHeader title="Approvals" summary={`${mine.length} waiting on you · one inbox for every module`}
        actions={<Tabs value={tab} onChange={setTab} options={[{ id: 'mine', label: 'Waiting on me', count: mine.length }, { id: 'all', label: 'All routes', count: all.length }]} />} />
      <div className="grid two" style={{ gridTemplateColumns: '1fr 320px' }}>
        <div className="stack">
          {list.length === 0 && <GlassCard><div className="tbl-empty"><Icon name="checkCircle" size={20} /><div>You’re all caught up</div></div></GlassCard>}
          {list.map(i => <ApprovalCard key={i.key} item={i} onOpen={() => setOpen(i.key)} />)}
        </div>
        <div className="stack" style={{ alignSelf: 'start' }}>
          <DelegationCard />
          <GlassCard title="How timing works"><ul className="list-plain body-sm muted">
            <li>Reminder at 1 business day, routed to backup at 2, escalated at 3.</li>
            <li>Emergency: re-alert every 24h, escalate after two unanswered.</li>
            <li><b>Nothing ever auto-approves, auto-rejects, moves or checks out a resident.</b></li>
          </ul></GlassCard>
        </div>
      </div>
      {open && all.find(i => i.key === open)?.kind === 'Request' && <RequestDrawer reqId={open} onClose={() => setOpen(null)} />}
    </>
  )
}

export function ApprovalCard({ item: i, onOpen }: { item: ApprovalItem; onOpen: () => void }) {
  const { s, persona, now, go } = useCtx()
  const act = useAct()
  const [reason, setReason] = useState('')
  const [showReject, setShowReject] = useState(false)
  const tone = i.level === 2 ? 'danger' : i.level === 1 ? 'warning' : 'info'
  const reject = (fn: () => ReturnType<typeof A.decideTransfer>) => { if (!showReject) { setShowReject(true); return } act(fn()) }
  const ext = i.kind === 'Extension' ? s.extensions.find(e => e.id === i.ref) : undefined
  const extConflict = ext ? (() => { const st = s.stays.find(x => x.id === ext.stayId)!; return bedConflict(s, st.bedId, { from: addDays(st.end ?? today(now), 1), to: ext.newEnd }, { stayId: st.id }) })() : null
  return (
    <GlassCard strong className="approval">
      <div className="approval-card">
        <div className="row wrap">
          <Badge tone="brand" dot={false}>{i.kind}</Badge>
          {i.urgent && <Badge tone="danger">Urgent</Badge>}
          <Badge tone={tone}>{i.label}</Badge>
          <span className="spacer" />
          <span className="subtle body-sm">Raised {fmtDateTime(i.createdAt)}</span>
        </div>
        <div><b style={{ fontSize: 15 }}>{i.title}</b><div className="muted">{i.sub}</div></div>
        <div className="chips">
          <Badge outline>Route: {i.primary} → {i.backup}</Badge>
          <Badge outline>Now with: {i.current}</Badge>
          <Badge outline>Reminders: {i.reminders}</Badge>
          <Badge outline>Escalation level {i.level}</Badge>
          {i.deadline && <Countdown to={i.deadline} label="to decide" warnBelowMs={6 * 3600_000} />}
        </div>
        {!i.mine && i.why && <Blocked why={`Why you can’t approve: ${i.why}`} owner={i.current} />}
        {ext && extConflict && <Blocked why={`The next booking on this bed (${extConflict.who}) clashes with ${fmtDate(ext.newEnd)}`} owner="Accommodation Admin" next="Offer a transfer instead of rejecting" />}
        {i.mine && (
          <div className="stack" style={{ gap: 8 }}>
            {showReject && <Field label="Reason for rejecting"><Textarea value={reason} onChange={e => setReason(e.target.value)} /></Field>}
            <div className="row wrap">
              {i.kind === 'Request' && <><Button variant="primary" onClick={onOpen}>Review and allocate</Button></>}
              {(i.kind === 'Transfer' || i.kind === 'Swap') && <><Button variant="primary" onClick={() => act(A.decideTransfer(persona, i.ref, true, ''))}>Approve</Button><Button variant="danger" onClick={() => reject(() => A.decideTransfer(persona, i.ref, false, reason))}>{showReject ? 'Confirm reject' : 'Reject'}</Button></>}
              {i.kind === 'Extension' && <><Button variant="primary" onClick={() => act(A.decideExtension(persona, i.ref, true, ''))}>Approve</Button><Button variant="danger" onClick={() => { if (!showReject) setShowReject(true); else act(A.decideExtension(persona, i.ref, false, reason)) }}>{showReject ? 'Confirm reject' : 'Reject'}</Button>{extConflict && <Button onClick={() => go('transfers', { offer: ext!.stayId })}>Offer transfer</Button>}</>}
              {i.kind === 'Emergency' && <><Button variant="primary" onClick={() => act(A.decideEmergency(persona, i.ref, true, ''))}>Approve provisional stay</Button><Button variant="danger" onClick={() => { if (!showReject) setShowReject(true); else act(A.decideEmergency(persona, i.ref, false, reason)) }}>{showReject ? 'Confirm reject' : 'Reject'}</Button></>}
              {i.kind === 'Migration' && <Button variant="primary" onClick={() => act(A.signOffMigration(persona))}>Sign off and import</Button>}
              {i.kind === 'Work order' && <Button variant="primary" onClick={() => act(A.advanceWorkOrder(persona, i.ref, 'Verified'))}>Verify work</Button>}
            </div>
          </div>
        )}
      </div>
    </GlassCard>
  )
}

/** Allocation drawer: AA approval selects the bed and creates the reservation in one atomic step (D-44). */
export function RequestDrawer({ reqId, onClose }: { reqId: string; onClose: () => void }) {
  const { s, persona } = useCtx()
  const act = useAct()
  const q = s.requests.find(x => x.id === reqId)
  const [bedId, setBedId] = useState('')
  const [reason, setReason] = useState('')
  const [exc, setExc] = useState('')
  if (!q) return null
  const staff = staffById(s, q.staffId)!
  const suggestions = suggestBeds(s, staff, { from: q.arrival, to: q.end }, persona.sites).slice(0, 12)
  const chosen = bedId ? bedById(s, bedId) : undefined
  const el = chosen ? eligibility(s, staff, chosen) : undefined
  const pick = chosen && !suggestions.some(b => b.id === chosen.id) ? chosen : undefined
  return (
    <Drawer open onClose={onClose} title={`Allocate: ${staff.name}`} subtitle={`${q.stayType} · ${fmtDate(q.arrival)} → ${fmtDate(q.end)}`}
      footer={<>
        <Button onClick={() => act(A.waitlistRequest(persona, q.id), onClose)}>No bed: waitlist</Button>
        <Button variant="danger" onClick={() => reason.trim() ? act(A.rejectRequest(persona, q.id, reason), onClose) : act({ ok: false, reason: 'Enter a reason to reject', owner: 'You' })}>Reject</Button>
        <Button variant="primary" disabled={!bedId} onClick={() => act(A.approveRequest(persona, q.id, bedId, { exceptionReason: exc || undefined }), onClose)}>Approve and reserve</Button>
      </>}>
      <div className="row"><Person name={staff.name} sub={`${staff.id} · ${staff.dept} · G${staff.grade} · ${staff.gender}`} /></div>
      <Alert tone="info" title="One atomic step" detail="Approving selects the bed and creates the reservation together. Reception then executes check-in. We re-check the bed at confirm time, so if someone else takes it first you'll be told and offered the next one." />
      <section>
        <h3>Suggested beds</h3>
        <div className="muted body-sm" style={{ marginBottom: 8 }}>Eligible and free for these dates. Needs-cleaning beds are allowed: readiness gates check-in, not reservation.</div>
        {suggestions.length === 0 ? <Blocked why="No eligible free bed for these dates" owner="Accommodation Admin" next="Waitlist the request, or request an eligibility exception" /> :
          <div className="bed-grid">{suggestions.map(b => (
            <button key={b.id} className={`bed ${bedId === b.id ? 'sel' : ''} ${b.state === 'Available' ? 'available' : 'blocked'}`} onClick={() => setBedId(b.id)}>
              <span className="code">{b.code}</span><span className="sub">{b.state === 'Available' ? 'Available now' : b.state === 'NeedsCleaning' ? 'Needs cleaning' : 'Awaiting inspection'}</span>
            </button>))}</div>}
      </section>
      <Field label="Or choose any bed by code" hint="Checked for eligibility and conflicts when you confirm"><Select value={bedId} onChange={e => setBedId(e.target.value)}><option value="">Select…</option>{s.beds.filter(b => b.state !== 'Archived').map(b => <option key={b.id} value={b.id}>{b.code}</option>)}</Select></Field>
      {pick && el && !el.ok && <Blocked why={el.reasons.join('; ')} owner="Policy Approver" next="Add an exception reason (Policy Approver only), or pick another bed" />}
      {pick && el && !el.ok && <Field label="Eligibility exception reason" hint={isPA(persona) ? 'Recorded with your name and reported' : 'Only a Policy Approver can grant this'}><Textarea value={exc} onChange={e => setExc(e.target.value)} /></Field>}
      <Field label="Reason (only needed to reject)" optional><Textarea value={reason} onChange={e => setReason(e.target.value)} /></Field>
    </Drawer>
  )
}

function DelegationCard() {
  const { s, persona, now } = useCtx()
  const act = useAct()
  const approvers = PERSONAS.filter(p => p.id !== persona.id && (p.role === 'AA' || isPA(p)))
  const [to, setTo] = useState(approvers[0]?.name ?? '')
  const T = today(now)
  const [from, setFrom] = useState(T), [until, setUntil] = useState(addDays(T, 7))
  const mine = s.delegations.find(d => d.from === persona.name)
  return (
    <GlassCard title="Out of office" subtitle="Set a delegate and dates. This is how the system knows you’re absent.">
      {mine && <Alert tone="success" title={`Delegated to ${mine.to}`} detail={`${mine.fromDate} to ${mine.toDate}`} />}
      <div className="stack" style={{ marginTop: mine ? 12 : 0 }}>
        <Field label="Delegate"><Select value={to} onChange={e => setTo(e.target.value)}>{approvers.map(p => <option key={p.id}>{p.name}</option>)}</Select></Field>
        <div className="grid even"><Field label="From"><Input type="date" value={from} onChange={e => setFrom(e.target.value)} /></Field><Field label="Until"><Input type="date" value={until} onChange={e => setUntil(e.target.value)} /></Field></div>
        <Button onClick={() => act(A.setDelegation(persona, { to, fromDate: from, toDate: until }))}>Save delegate</Button>
      </div>
    </GlassCard>
  )
}
