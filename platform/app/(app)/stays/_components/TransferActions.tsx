'use client'
/** What can be done to one transfer or swap request, by whoever may do it. Every refusal comes back with reason, owner and next action. */
import { useState } from 'react'
import { Alert, Blocked, Button, Field, Select, Textarea } from '@/ui'
import type { TransferListRow } from '@/server/queries/stays/transfers'
import { Problem, useCall } from './call'
import { TransferException } from './TransferException'

export function TransferActions({ t }: { t: TransferListRow }) {
  const { run, busy, err } = useCall()
  const [dest, setDest] = useState(t.toBedId ?? '')
  const [rejecting, setRejecting] = useState(false)
  const [declining, setDeclining] = useState(false)
  const [reason, setReason] = useState('')
  const [via, setVia] = useState<'in_person' | 'phone' | 'written'>('in_person')
  const base = `/api/v1/stays/transfers/${t.id}`
  const open = t.status === 'requested' || t.status === 'failed'
  // Only whoever gives the DESTINATION site's key chooses the bed (for a same-site move that is the one approver, as before).
  const needsDest = t.kind === 'transfer' && open && t.can.chooseBed
  const gives = t.keys.source.viewerCanGive && t.keys.destination.viewerCanGive ? 'both' : t.keys.source.viewerCanGive ? 'source' : 'destination'
  const approveLabel = !t.crossSite ? (t.status === 'failed' ? 'Approve with this bed' : `Approve ${t.kind}`)
    : gives === 'both' ? `Approve for both sites` : gives === 'source' ? `Approve: let them leave ${t.siteName}` : `Approve: take them into ${t.destinationSiteName}`
  const otherSideWaits = t.crossSite && ((gives === 'source' && !t.keys.destination.approved) || (gives === 'destination' && !t.keys.source.approved))
  const canAsk = t.exceptionPath && (err?.detail as { canAskException?: boolean } | undefined)?.canAskException === true
  const missing = t.consent ? [!t.consent.a && t.name, !t.consent.b && t.otherName].filter(Boolean) as string[] : []

  return (
    <div className="stack" style={{ gap: 10 }}>
      {err && <Problem f={err} />}
      {/* P-10 (proposed, pending client sign-off): the destination bed fails a rule and a Policy Approver may be asked. Explicit, never automatic. */}
      {err && canAsk && needsDest && dest && (
        <div className="row wrap">
          <Button size="sm" disabled={busy} onClick={() => run(`${base}/approve`, { destinationBedId: dest, askException: true })}>Ask a Policy Approver for an exception for this bed</Button>
          <span className="muted body-sm">Proposed policy, pending client sign-off. Your approval is not given until they decide.</span>
        </div>
      )}
      <TransferException transferId={t.id} exceptions={t.exceptions} kind={t.kind} />

      {t.kind === 'swap' && t.status === 'requested' && missing.length > 0 && (
        <Blocked why={`Waiting for ${missing.join(' and ')} to agree to the swap`} owner="The resident, or the Accommodation Admin recording it" next="The resident confirms in the app, or record how they agreed (in person, by phone, in writing)" />
      )}
      {t.viewerParty && t.status === 'requested' && !(t.viewerParty === 'a' ? t.consent?.a : t.consent?.b) && (
        <div className="stack" style={{ gap: 8 }}>
          <Alert tone="info" title="Someone proposed a bed swap with you" detail="You only move if you agree. If the swap cannot be carried out you stay where you are." />
          {!declining
            ? <div className="row wrap"><Button variant="primary" size="sm" disabled={busy} onClick={() => run(`${base}/consent`, {})}>I agree to this swap</Button><Button size="sm" onClick={() => setDeclining(true)}>I do not agree</Button></div>
            : <>
              <Field label="Why not?" error={err?.fields?.reason}><Textarea value={reason} onChange={e => setReason(e.target.value)} /></Field>
              <div className="row wrap"><Button variant="danger" size="sm" disabled={busy || reason.trim().length < 3} onClick={() => run(`${base}/reject`, { reason })}>Decline the swap</Button><Button variant="ghost" size="sm" onClick={() => setDeclining(false)}>Back</Button></div>
            </>}
        </div>
      )}
      {t.can.consent && !t.viewerParty && missing.length > 0 && (
        <div className="row wrap">
          <Select aria-label="How they agreed" value={via} onChange={e => setVia(e.target.value as typeof via)} style={{ maxWidth: 180 }}>
            <option value="in_person">In person</option><option value="phone">By phone</option><option value="written">In writing</option>
          </Select>
          {!t.consent!.a && <Button size="sm" disabled={busy} onClick={() => run(`${base}/consent`, { party: 'a', via })}>Record consent: {t.name}</Button>}
          {!t.consent!.b && <Button size="sm" disabled={busy} onClick={() => run(`${base}/consent`, { party: 'b', via })}>Record consent: {t.otherName}</Button>}
        </div>
      )}

      {t.can.approve && open && !rejecting && (
        <>
          {needsDest && (
            <Field label="Destination bed" hint={t.suggestions.length ? 'Beds that are ready now and free for the whole stay.' : 'No ready bed is free for the whole stay right now.'}>
              <Select value={dest} onChange={e => setDest(e.target.value)}>
                <option value="">Choose a bed</option>
                {t.toBedId && !t.suggestions.some(s => s.bedId === t.toBedId) && t.status !== 'failed' && <option value={t.toBedId}>{t.toBedLabel ?? 'Requested bed'}</option>}
                {t.suggestions.map(s => <option key={s.bedId} value={s.bedId}>{s.roomName} · {s.code}</option>)}
              </Select>
            </Field>
          )}
          <div className="row wrap">
            <Button variant="primary" size="sm" disabled={busy || (needsDest && !dest) || missing.length > 0} onClick={() => run(`${base}/approve`, { destinationBedId: needsDest ? dest || null : null })}>
              {approveLabel}
            </Button>
            <Button size="sm" onClick={() => setRejecting(true)}>Reject</Button>
          </div>
          {otherSideWaits && <Alert tone="info" title="Your approval is only half of it" detail={`${gives === 'source' ? `The Accommodation Admin of ${t.destinationSiteName}` : `The Accommodation Admin of ${t.siteName}`} has to approve too${gives === 'source' && t.kind === 'transfer' ? ' and chooses the bed there' : ''}. Nobody moves until both sites have approved.`} />}
        </>
      )}
      {t.can.approve && open && rejecting && (
        <>
          <Field label="Reason for rejecting" error={err?.fields?.reason}><Textarea value={reason} onChange={e => setReason(e.target.value)} /></Field>
          <div className="row wrap">
            <Button variant="danger" size="sm" disabled={busy || reason.trim().length < 3} onClick={() => run(`${base}/reject`, { reason })}>Reject {t.kind}</Button>
            <Button variant="ghost" size="sm" onClick={() => setRejecting(false)}>Back</Button>
          </div>
        </>
      )}
      {!t.can.approve && t.status === 'requested' && !t.crossSite && <Alert tone="info" title="Waiting for approval" detail="An Accommodation Admin who is not part of this request decides it. If you raised it, you cannot approve it (separation of duties)." />}
      {!t.can.approve && t.status === 'requested' && t.crossSite && (
        <Alert tone="info" title="You cannot approve this one" detail="Each site's Accommodation Admin gives their own approval, and nobody approves a move they raised or are part of (separation of duties)." />
      )}

      {t.can.execute && (
        <div className="row wrap">
          <Button variant="primary" size="sm" disabled={busy} onClick={() => run(`${base}/execute`, {})}>Carry out {t.kind === 'swap' ? 'swap' : 'move'} now</Button>
          <span className="muted body-sm">Keys are returned and issued at Reception; the old bed then needs cleaning.</span>
        </div>
      )}
      {t.status === 'approved' && !t.can.execute && <Alert tone="info" title="Approved: waiting for Reception" detail="Reception carries it out when the resident is ready." />}

      {t.can.cancel && (
        <div><Button variant="ghost" size="sm" disabled={busy} onClick={() => run('/api/v1/stays/requests/cancel', { kind: 'transfer', id: t.id })}>Withdraw request</Button></div>
      )}
    </div>
  )
}
