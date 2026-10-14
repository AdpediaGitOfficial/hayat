'use client'
/**
 * What the viewer can DO on a request: the Accommodation Admin picks a bed and approves (one atomic step), sends it back or
 * rejects; a Policy Approver grants or declines an exception; the requester edits, resubmits or cancels. The server decides
 * what is offered (RequestDetail.can) and checks again on every call; a refusal shows reason, owner and next action (D-93).
 */
import { useState } from 'react'
import { Alert, Blocked, Button, Check, Field, GlassCard, Input, Modal, Select, Textarea } from '@/ui'
import type { RequestDetail } from '@/server/queries/requests/detail'
import type { BedsForRequest } from '@/server/queries/requests/beds'
import { Problem, useCall } from './common'
import type { SiteOption } from './RequestForm'

type Kind = 'gender' | 'grade'

function ReasonModal({ title, subtitle, cta, danger, open, onClose, onGo, busy, err, label = 'Reason' }: {
  title: string; subtitle?: string; cta: string; danger?: boolean; open: boolean; onClose: () => void; onGo: (reason: string) => void; busy: boolean
  err?: Parameters<typeof Problem>[0]['f']; label?: string
}) {
  const [reason, setReason] = useState('')
  return (
    <Modal open={open} onClose={onClose} title={title} subtitle={subtitle}
      footer={<><Button onClick={onClose}>Back</Button><Button variant={danger ? 'danger' : 'primary'} disabled={busy || reason.trim().length < 3} onClick={() => onGo(reason)}>{busy ? 'Working…' : cta}</Button></>}>
      <div className="stack">
        {err && <Problem f={err} />}
        <Field label={label} hint="At least 3 characters. Recorded in the audit log" error={err?.fields?.reason}><Textarea value={reason} onChange={e => setReason(e.target.value)} autoFocus /></Field>
      </div>
    </Modal>
  )
}

export function RequestActions({ request, beds, sites }: { request: RequestDetail; beds?: BedsForRequest; sites: SiteOption[] }) {
  const c = request.can
  const nothing = !c.approve && !c.grantException && !c.edit && !c.cancel
  return (
    <div className="stack" style={{ alignSelf: 'start' }}>
      {c.whyNot && <Blocked why={c.whyNot} owner="An independent approver" next="Ask a colleague with the same role to decide it" />}
      {c.approve && beds && <ApproveBox request={request} beds={beds} />}
      {c.grantException && <ExceptionDecision request={request} />}
      {c.edit && <EditBox request={request} sites={sites} />}
      {c.cancel && <CancelBox id={request.id} />}
      {nothing && !c.whyNot && <GlassCard title="Nothing for you to do here"><p className="muted body-sm">{request.status === 'pending_approval' ? 'A Policy Approver is deciding an exception. You will be notified.' : request.status === 'changes_requested' ? 'It is back with the requester.' : 'This request has been decided.'}</p></GlassCard>}
    </div>
  )
}

/* ---------------- Accommodation Admin ---------------- */

function ApproveBox({ request, beds }: { request: RequestDetail; beds: BedsForRequest }) {
  const { run, busy, err, clear } = useCall()
  const [bedId, setBedId] = useState('')
  const [modal, setModal] = useState<'reject' | 'changes' | 'exception' | undefined>()
  const [exReason, setExReason] = useState('')
  const sug = new Set(beds.suggestions.map(s => s.bedId))
  const others = beds.beds.filter(b => !sug.has(b.bedId))
  const needsException = (err?.detail as { policyApproverException?: boolean } | undefined)?.policyApproverException === true
  const chosen = beds.beds.find(b => b.bedId === bedId)

  return (
    <GlassCard title="Approve and reserve" subtitle="Choosing the bed and reserving it is one step. We check the bed again at that moment; if someone has just taken it you are told and offered the next one.">
      <div className="stack">
        {err && !needsException && <Problem f={err} />}
        {needsException && err && (
          <div className="stack" style={{ gap: 10 }}>
            <Blocked why={err.reason} owner={err.owner} next={err.next} />
            <Button onClick={() => { setModal('exception'); setExReason('') }} icon="shield">Ask a Policy Approver for an exception</Button>
          </div>
        )}
        <section>
          <h3>Suggested beds</h3>
          <div className="muted body-sm" style={{ marginBottom: 8 }}>Eligible and free for these dates. A bed that still needs cleaning can be reserved: readiness gates check-in, not the reservation.</div>
          {beds.suggestions.length === 0
            ? <Blocked why="No eligible free bed for these dates" owner="Accommodation Admin" next="Choose a different bed below, send the request back, or reject it. A waitlist offer is the next step when no bed is free" />
            : <div className="bed-grid" role="listbox" aria-label="Suggested beds">{beds.suggestions.map(b => (
              <button key={b.bedId} type="button" role="option" aria-selected={bedId === b.bedId} className={`bed ${bedId === b.bedId ? 'sel' : ''} ${b.state === 'available' ? 'available' : 'reserved'}`} onClick={() => { setBedId(b.bedId); clear() }}>
                <span className="code">{b.code}</span><span className="sub">Room {b.roomName}</span><span className="sub">{b.state === 'available' ? 'Ready now' : b.state.replace(/_/g, ' ')}</span>
              </button>))}</div>}
        </section>
        {others.length > 0 && (
          <Field label="Or choose any other bed at this site" hint="Checked for eligibility and conflicts when you approve">
            <Select value={sug.has(bedId) ? '' : bedId} onChange={e => { setBedId(e.target.value); clear() }}>
              <option value="">Select a bed…</option>
              {others.map(b => <option key={b.bedId} value={b.bedId}>{b.code} · Room {b.roomName}{b.free ? '' : ' · taken for these dates'}{b.state !== 'available' ? ` · ${b.state.replace(/_/g, ' ')}` : ''}</option>)}
            </Select>
          </Field>
        )}
        <div className="row wrap">
          <Button variant="primary" tall disabled={busy || !bedId} onClick={() => run('POST', `/api/v1/requests/${request.id}/approve`, { bedId })}>
            {busy ? 'Reserving…' : chosen ? `Approve and reserve ${chosen.code}` : 'Approve and reserve'}
          </Button>
        </div>
        <div className="row wrap">
          <Button onClick={() => { setModal('changes'); clear() }}>Send back for changes</Button>
          <Button variant="danger" onClick={() => { setModal('reject'); clear() }}>Reject</Button>
        </div>
      </div>

      <ReasonModal open={modal === 'changes'} onClose={() => setModal(undefined)} title="Send back for changes" subtitle="The requester is told what to fix. Nothing is reserved." cta="Send back" busy={busy} err={err}
        onGo={reason => run('POST', `/api/v1/requests/${request.id}/changes`, { reason }, () => setModal(undefined))} />
      <ReasonModal open={modal === 'reject'} onClose={() => setModal(undefined)} title="Reject this request" subtitle="The resident is told why. A rejected request is final; they can file a new one." cta="Reject" danger busy={busy} err={err}
        onGo={reason => run('POST', `/api/v1/requests/${request.id}/reject`, { reason }, () => setModal(undefined))} />
      <Modal open={modal === 'exception'} onClose={() => setModal(undefined)} title="Ask for a Policy Approver exception" subtitle="The request waits for their decision. They see your reason and the refusal."
        footer={<><Button onClick={() => setModal(undefined)}>Back</Button><Button variant="primary" disabled={busy || exReason.trim().length < 3} onClick={() => run('POST', `/api/v1/requests/${request.id}/exception/request`, { bedId: bedId || undefined, reason: exReason }, () => setModal(undefined))}>{busy ? 'Sending…' : 'Send to Policy Approver'}</Button></>}>
        <div className="stack">
          {err && !needsException && <Problem f={err} />}
          <Field label="Why is this exception needed?" hint="At least 3 characters" error={err?.fields?.reason}><Textarea value={exReason} onChange={e => setExReason(e.target.value)} autoFocus /></Field>
        </div>
      </Modal>
    </GlassCard>
  )
}

/* ---------------- Policy Approver ---------------- */

function ExceptionDecision({ request }: { request: RequestDetail }) {
  const { run, busy, err } = useCall()
  const asked = request.exception?.asks.find(a => a.status === 'asked')
  const [kinds, setKinds] = useState<Kind[]>((asked?.kinds ?? []) as Kind[])
  const [reason, setReason] = useState('')
  const [evidence, setEvidence] = useState('')
  const [declining, setDeclining] = useState(false)
  const toggle = (k: Kind, on: boolean) => setKinds(on ? [...new Set([...kinds, k])] : kinds.filter(x => x !== k))
  return (
    <GlassCard title="Exception decision" subtitle="Gender and grade exceptions are decided by a Policy Approver (D-25). Reason and evidence are required, and every use is reported.">
      <div className="stack">
        {err && <Problem f={err} />}
        {asked && <Alert tone="info" title={`Asked for: ${asked.kinds.join(' and ')}`} detail={asked.reason} />}
        <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="label">Which rule is waived?</legend>
          <div className="row wrap" style={{ gap: 16, marginTop: 6 }}>
            <Check checked={kinds.includes('gender')} onChange={on => toggle('gender', on)}>Gender (room policy)</Check>
            <Check checked={kinds.includes('grade')} onChange={on => toggle('grade', on)}>Grade (site minimum)</Check>
          </div>
        </fieldset>
        <Field label="Reason" error={err?.fields?.reason}><Textarea value={reason} onChange={e => setReason(e.target.value)} /></Field>
        <Field label="Evidence" hint="What supports it: a memo, an email, a decision reference" error={err?.fields?.evidence}><Textarea value={evidence} onChange={e => setEvidence(e.target.value)} /></Field>
        <div className="row wrap">
          <Button variant="primary" disabled={busy || kinds.length === 0 || reason.trim().length < 3 || evidence.trim().length < 3}
            onClick={() => run('POST', `/api/v1/requests/${request.id}/exception/grant`, { kinds, reason, evidence })}>Grant exception</Button>
          {request.status === 'pending_approval' && <Button variant="danger" onClick={() => setDeclining(true)}>Decline</Button>}
        </div>
      </div>
      <ReasonModal open={declining} onClose={() => setDeclining(false)} title="Decline the exception" subtitle="The request goes back to the Accommodation Admin with your reason." cta="Decline" danger busy={busy} err={err}
        onGo={r => run('POST', `/api/v1/requests/${request.id}/exception/decline`, { reason: r }, () => setDeclining(false))} />
    </GlassCard>
  )
}

/* ---------------- the requester ---------------- */

function EditBox({ request, sites }: { request: RequestDetail; sites: SiteOption[] }) {
  const { run, busy, err } = useCall()
  const [siteId, setSiteId] = useState(request.site.id)
  const [arrivalDate, setArrival] = useState(request.arrivalDate)
  const [endDate, setEnd] = useState(request.endDate ?? '')
  const [stayType, setType] = useState<string>(request.stayType)
  const [note, setNote] = useState(request.note ?? '')
  const fe = err?.fields ?? {}
  return (
    <GlassCard title="Change and send back" subtitle="The Accommodation Admin asked for changes. Update the request and send it back; nothing is lost.">
      <form className="form" noValidate onSubmit={e => { e.preventDefault(); void run('POST', `/api/v1/requests/${request.id}/edit`, { siteId, arrivalDate, endDate: endDate || null, stayType, note: note || null, resubmit: true }) }}>
        {err && <Problem f={err} />}
        {sites.length > 1 && <Field label="Site" error={fe.siteId}><Select value={siteId} onChange={e => setSiteId(e.target.value)}>{sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>}
        <div className="grid even">
          <Field label="Arrival date" error={fe.arrivalDate}><Input type="date" value={arrivalDate} onChange={e => setArrival(e.target.value)} invalid={!!fe.arrivalDate} /></Field>
          <Field label="Departure day" error={fe.endDate} hint={stayType === 'permanent' ? 'Empty = open-ended' : 'Required'}><Input type="date" value={endDate} min={arrivalDate} onChange={e => setEnd(e.target.value)} invalid={!!fe.endDate} /></Field>
        </div>
        <Field label="Stay type" error={fe.stayType}><Select value={stayType} onChange={e => setType(e.target.value)}><option value="contract">Contract</option><option value="trainee">Trainee</option><option value="permanent">Permanent</option></Select></Field>
        <Field label="Note" optional error={fe.note}><Textarea value={note} onChange={e => setNote(e.target.value)} maxLength={500} /></Field>
        <div><Button variant="primary" type="submit" tall disabled={busy}>{busy ? 'Sending…' : 'Save and send back'}</Button></div>
      </form>
    </GlassCard>
  )
}

function CancelBox({ id }: { id: string }) {
  const { run, busy, err } = useCall()
  const [open, setOpen] = useState(false)
  return (
    <GlassCard title="Cancel this request">
      <p className="muted body-sm" style={{ marginBottom: 12 }}>Withdraws the request. Nothing is reserved, and a new request can be filed later.</p>
      <Button variant="danger" onClick={() => setOpen(true)}>Cancel request</Button>
      <ReasonModal open={open} onClose={() => setOpen(false)} title="Cancel this request" cta="Cancel request" danger busy={busy} err={err}
        onGo={reason => run('POST', `/api/v1/requests/${id}/cancel`, { reason }, () => setOpen(false))} />
    </GlassCard>
  )
}
