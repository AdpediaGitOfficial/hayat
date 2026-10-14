'use client'
/**
 * Actions on one stay: ask for an extension, ask to move, ask to leave, check out, and decide what is waiting. Every form is a
 * thin client over the stays API; the server decides and a refusal is shown as reason, owner and next action (D-93).
 */
import { useState } from 'react'
import { Alert, Badge, Blocked, Button, Field, GlassCard, Input, Select, Status, Textarea } from '@/ui'
import { fmtDate } from '@/domain/time'
import { dayDiff } from '@/server/commands/stays/rules'
import type { RequestExtensionOut } from '@/server/commands/stays/extension'
import type { BedSuggestion } from '@/server/allocation'
import { Problem, useCall } from './call'

export interface StayCtx { id: string; name: string; from: string; to: string | null; active: boolean }
export interface Abilities {
  requestExtension: boolean; requestCheckout: boolean; requestTransfer: boolean; processCheckout: boolean; mine: boolean
}

/* ---------------- extension ---------------- */

export function ExtensionForm({ stay, policyDays, canOpenTransfer }: { stay: StayCtx; policyDays: number; canOpenTransfer: boolean }) {
  const { run, busy, err } = useCall()
  const [newEnd, setNewEnd] = useState('')
  const [reason, setReason] = useState('')
  const [out, setOut] = useState<RequestExtensionOut>()
  const added = stay.to && newEnd ? dayDiff(stay.to, newEnd) : 0
  const beyond = added > policyDays
  if (!stay.to) return null
  return (
    <GlassCard title="Request an extension" subtitle={`Up to ${policyDays} days more is decided by the Accommodation Admin; longer needs a Policy Approver and a reason. Your stay now ends on ${fmtDate(stay.to)}.`}>
      <form className="form" noValidate onSubmit={e => { e.preventDefault(); void run<RequestExtensionOut>(`/api/v1/stays/${stay.id}/extension`, { newEnd, reason: reason || null }, r => { setOut(r.data); setNewEnd(''); setReason('') }) }}>
        {err && <Problem f={err} />}
        <Field label="New departure day" hint={beyond ? `That is ${added} days more: beyond policy, so a Policy Approver decides and a reason is required.` : added > 0 ? `${added} days more.` : 'The day the stay would now end (you leave on this day).'} error={err?.fields?.newEnd}>
          <Input type="date" min={stay.to} value={newEnd} onChange={e => setNewEnd(e.target.value)} />
        </Field>
        <Field label="Reason" optional={!beyond} error={err?.fields?.reason}><Textarea value={reason} onChange={e => setReason(e.target.value)} /></Field>
        <div><Button variant="primary" type="submit" disabled={busy || !newEnd}>Request extension</Button></div>
      </form>
      {out?.clash && <div style={{ marginTop: 12 }}><Clash stayId={stay.id} extensionId={out.id} clash={out.clash} canOpenTransfer={canOpenTransfer} /></div>}
    </GlassCard>
  )
}

/** The next booking on this bed clashes: say so, and offer a transfer instead of a dead end (D-57). */
export function Clash({ stayId, extensionId, clash, canOpenTransfer }: { stayId: string; extensionId: string; clash: { message: string; suggestions: BedSuggestion[] }; canOpenTransfer: boolean }) {
  const { run, busy, err } = useCall()
  const [done, setDone] = useState(false)
  return (
    <div className="stack" style={{ gap: 8 }}>
      <Alert tone="warning" title="This bed is booked next" detail={`${clash.message} The extension cannot be approved on this bed.`} />
      {err && <Problem f={err} />}
      {clash.suggestions.length === 0
        ? <Blocked why="No ready bed is free for the whole stay" owner="Accommodation Admin" next="Choose a shorter extension, or find a bed by hand and request a transfer" />
        : <ul className="list-plain" aria-label="Suggested beds">
          {clash.suggestions.map(b => (
            <li key={b.bedId} style={{ flexWrap: 'wrap' }}>
              <span style={{ flex: 1 }}><b>{b.code}</b> <span className="muted body-sm">{b.roomName}</span></span>
              {canOpenTransfer
                ? <Button size="sm" disabled={busy || done} onClick={() => run(`/api/v1/stays/${stayId}/transfer`, { destinationBedId: b.bedId, reason: 'Next booking on the current bed clashes with the extension', linkedExtensionId: extensionId }, () => setDone(true))}>Open transfer to {b.code}</Button>
                : <Badge tone="info">Suggested</Badge>}
            </li>
          ))}
        </ul>}
      {done && <Alert tone="success" title="Transfer opened" detail="Another Accommodation Admin approves it, Reception carries it out, then the extension can be approved on the new bed." />}
    </div>
  )
}

/* ---------------- transfer ---------------- */

export function TransferForm({ stay, options }: { stay: StayCtx; options: BedSuggestion[] }) {
  const { run, busy, err } = useCall()
  const [dest, setDest] = useState('')
  const [reason, setReason] = useState('')
  return (
    <GlassCard title="Ask to move to another bed" subtitle="An Accommodation Admin decides, then Reception moves you. If the new bed is no longer free you stay where you are.">
      <form className="form" noValidate onSubmit={e => { e.preventDefault(); void run(`/api/v1/stays/${stay.id}/transfer`, { destinationBedId: dest || null, reason }, () => { setReason(''); setDest('') }) }}>
        {err && <Problem f={err} />}
        <Field label="Preferred bed" hint="Only beds that are ready now are listed. Leave on 'Any suitable bed' to let the Accommodation Admin choose." optional error={err?.fields?.destinationBedId}>
          <Select value={dest} onChange={e => setDest(e.target.value)}>
            <option value="">Any suitable bed</option>
            {options.map(b => <option key={b.bedId} value={b.bedId}>{b.roomName} · {b.code}</option>)}
          </Select>
        </Field>
        <Field label="Reason" error={err?.fields?.reason}><Textarea value={reason} onChange={e => setReason(e.target.value)} /></Field>
        <div><Button variant="primary" type="submit" disabled={busy || reason.trim().length < 3}>Request move</Button></div>
      </form>
    </GlassCard>
  )
}

/* ---------------- voluntary checkout ---------------- */

export function CheckoutRequestForm({ stay, today }: { stay: StayCtx; today: string }) {
  const { run, busy, err } = useCall()
  const [date, setDate] = useState('')
  const [note, setNote] = useState('')
  return (
    <GlassCard title="Tell us you are leaving" subtitle="Reception confirms with you within 1 business day. You keep your login and history. Keys and the room check happen at Reception.">
      <form className="form" noValidate onSubmit={e => { e.preventDefault(); void run(`/api/v1/stays/${stay.id}/checkout-request`, { departureDate: date, note: note || null }, () => { setDate(''); setNote('') }) }}>
        {err && <Problem f={err} />}
        <Field label="Departure day" error={err?.fields?.departureDate}><Input type="date" min={today} max={stay.to ?? undefined} value={date} onChange={e => setDate(e.target.value)} /></Field>
        <Field label="Note" optional><Textarea value={note} onChange={e => setNote(e.target.value)} /></Field>
        <div><Button variant="primary" type="submit" disabled={busy || !date}>Request checkout</Button></div>
      </form>
    </GlassCard>
  )
}

export function ProcessCheckout({ stay, requested }: { stay: StayCtx; requested?: { id: string; status: string; departureDate: string } }) {
  const { run, busy, err } = useCall()
  const [confirm, setConfirm] = useState(false)
  return (
    <GlassCard title="Check out" subtitle={`Records that ${stay.name} has left. The stay closes, the bed's claim is released and the bed goes to Needs cleaning. It is not available again until cleaning and the final inspection are done.`}>
      {err && <Problem f={err} />}
      {requested && (
        <div className="row wrap" style={{ marginBottom: 8 }}>
          <Status s={requested.status === 'acknowledged' ? 'Accepted' : 'Pending'} label={requested.status === 'acknowledged' ? 'Acknowledged' : 'Waiting for acknowledgement'} />
          <span className="body-sm">Resident asked to leave on {fmtDate(requested.departureDate)}</span>
          {requested.status === 'requested' && <Button size="sm" disabled={busy} onClick={() => run(`/api/v1/stays/checkout-requests/${requested.id}/acknowledge`, {})}>Acknowledge</Button>}
        </div>
      )}
      {!confirm
        ? <Button variant="primary" onClick={() => setConfirm(true)}>Check out {stay.name}</Button>
        : <div className="row wrap">
          <Button variant="danger" disabled={busy} onClick={() => run(`/api/v1/stays/${stay.id}/checkout`, { note: null })}>Confirm checkout</Button>
          <Button variant="ghost" onClick={() => setConfirm(false)}>Not yet</Button>
        </div>}
    </GlassCard>
  )
}

/* ---------------- deciding what is waiting ---------------- */

export function ExtensionDecision({ id, canDecide, why }: { id: string; canDecide: boolean; why?: string }) {
  const { run, busy, err } = useCall()
  const [rejecting, setRejecting] = useState(false)
  const [reason, setReason] = useState('')
  if (!canDecide) return why ? <Blocked why={why} owner="Accommodation Admin or Policy Approver" next="They decide it from their approvals inbox" /> : null
  return (
    <div className="stack" style={{ gap: 8 }}>
      {err && <Problem f={err} />}
      {!rejecting
        ? <div className="row wrap"><Button variant="primary" size="sm" disabled={busy} onClick={() => run(`/api/v1/stays/extensions/${id}/approve`, {})}>Approve extension</Button><Button size="sm" onClick={() => setRejecting(true)}>Reject</Button></div>
        : <>
          <Field label="Reason for rejecting" error={err?.fields?.reason}><Textarea value={reason} onChange={e => setReason(e.target.value)} /></Field>
          <div className="row wrap"><Button variant="danger" size="sm" disabled={busy || reason.trim().length < 3} onClick={() => run(`/api/v1/stays/extensions/${id}/reject`, { reason })}>Reject extension</Button><Button variant="ghost" size="sm" onClick={() => setRejecting(false)}>Back</Button></div>
        </>}
    </div>
  )
}

/** Waiting checkout requests on the Stays page: acknowledge, or process the departure. */
export function CheckoutRow({ id, stayId, canProcess, status }: { id: string; stayId: string; canProcess: boolean; status: string }) {
  const { run, busy, err } = useCall()
  const [confirm, setConfirm] = useState(false)
  if (!canProcess) return null
  return (
    <div className="stack" style={{ gap: 8 }}>
      {err && <Problem f={err} />}
      <div className="row wrap">
        {status === 'requested' && <Button size="sm" disabled={busy} onClick={() => run(`/api/v1/stays/checkout-requests/${id}/acknowledge`, {})}>Acknowledge</Button>}
        {!confirm ? <Button size="sm" variant="primary" onClick={() => setConfirm(true)}>Check out now</Button>
          : <><Button size="sm" variant="danger" disabled={busy} onClick={() => run(`/api/v1/stays/${stayId}/checkout`, { note: null })}>Confirm checkout</Button><Button size="sm" variant="ghost" onClick={() => setConfirm(false)}>Not yet</Button></>}
      </div>
    </div>
  )
}

export function CancelRequest({ kind, id, label = 'Withdraw request' }: { kind: 'transfer' | 'extension' | 'checkout'; id: string; label?: string }) {
  const { run, busy, err } = useCall()
  return (
    <span>
      {err && <Problem f={err} />}
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => run('/api/v1/stays/requests/cancel', { kind, id })}>{label}</Button>
    </span>
  )
}
