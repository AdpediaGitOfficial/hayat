'use client'
/**
 * The destination checks of a transfer or swap that a Policy Approver can decide (S-21, P-10: PROPOSED, pending client sign-off; the
 * server shows these only while `transfers.exception_path` is on). Everyone sees the failed rules with reason, owner and next action;
 * a Policy Approver of the destination site also gets the form: which rule, why, the evidence, and their password again (D-03).
 * The exception counts for this one move only. The server decides; this is a thin form.
 */
import { useState } from 'react'
import { Alert, Badge, Blocked, Button, ConfirmPassword, Field, Textarea } from '@/ui'
import type { ExceptionView } from '@/server/queries/stays/transfers'
import { Problem, useCall } from './call'

export function TransferException({ transferId, exceptions, kind }: { transferId: string; exceptions: ExceptionView[]; kind: 'transfer' | 'swap' }) {
  if (exceptions.length === 0) return null
  return (
    <div className="stack" style={{ gap: 10 }} data-testid="transfer-exceptions">
      {exceptions.map(e => <One key={`${e.staffId}:${e.bedLabel}`} transferId={transferId} e={e} kind={kind} />)}
    </div>
  )
}

function One({ transferId, e }: { transferId: string; e: ExceptionView; kind: 'transfer' | 'swap' }) {
  const { run, busy, err } = useCall()
  const [mode, setMode] = useState<'grant' | 'decline' | null>(null)
  const [kinds, setKinds] = useState<('gender' | 'grade')[]>(e.failed)
  const [reason, setReason] = useState('')
  const [evidence, setEvidence] = useState('')
  const [password, setPassword] = useState('')
  const base = `/api/v1/stays/transfers/${transferId}/exception`

  if (e.state === 'blocked') {
    return <Blocked why={`${e.name}: ${e.reasons.join('; ')}`} owner="Accommodation Admin" next="No exception can be granted for this. Reject the move, or review the employment status" />
  }
  if (e.state === 'declined') {
    return <Blocked why={`A Policy Approver declined the exception for ${e.name} (${e.bedLabel}): ${e.declinedReason ?? ''}`} owner={`Accommodation Admin of ${e.siteName}`} next="Choose another bed, or reject the move" />
  }
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="row wrap" style={{ gap: 8 }}>
        <Badge tone="warning">Waiting for a Policy Approver exception</Badge>
        <Badge tone="neutral" outline>Proposed policy, pending client sign-off</Badge>
      </div>
      <Blocked
        why={`${e.name} would move into ${e.bedLabel}, which fails a rule of ${e.siteName}: ${e.reasons.join('; ')}`}
        owner={`Policy Approver of ${e.siteName}`}
        next="Record an exception with the reason and the evidence, or decline it. The exception counts for this move only" />
      {e.viewerCanDecide && mode === null && (
        <div className="row wrap">
          <Button variant="primary" size="sm" onClick={() => setMode('grant')}>Record an exception…</Button>
          <Button size="sm" onClick={() => setMode('decline')}>Decline…</Button>
        </div>
      )}
      {e.viewerCanDecide && mode !== null && (
        <form className="form" noValidate onSubmit={ev => { ev.preventDefault(); void run(`${base}/${mode}`, mode === 'grant'
          ? { staffId: e.staffId, kinds, reason, evidence, confirmPassword: password }
          : { staffId: e.staffId, reason, confirmPassword: password }, () => { setMode(null); setReason(''); setEvidence(''); setPassword('') }) }}>
          {err && <Problem f={err} />}
          {mode === 'grant' && (
            <Field label="Which rule" error={err?.fields?.kinds} hint="Only the rules this bed fails can be waived.">
              <div className="row wrap">
                {e.failed.map(k => (
                  <label key={k} className="row" style={{ gap: 6 }}>
                    <input type="checkbox" checked={kinds.includes(k)} onChange={ev => setKinds(ev.target.checked ? [...kinds, k] : kinds.filter(x => x !== k))} /> {k === 'gender' ? 'Gender rule' : 'Grade rule'}
                  </label>
                ))}
              </div>
            </Field>
          )}
          <Field label="Reason" error={err?.fields?.reason}><Textarea value={reason} onChange={ev => setReason(ev.target.value)} /></Field>
          {mode === 'grant' && <Field label="Evidence" hint="What supports this exception? It is kept with the record." error={err?.fields?.evidence}><Textarea value={evidence} onChange={ev => setEvidence(ev.target.value)} /></Field>}
          <ConfirmPassword value={password} onChange={setPassword} error={err?.fields?.confirmPassword} />
          <div className="row wrap">
            <Button variant={mode === 'grant' ? 'primary' : 'danger'} type="submit"
              disabled={busy || reason.trim().length < 3 || !password || (mode === 'grant' && (evidence.trim().length < 3 || kinds.length === 0))}>
              {mode === 'grant' ? 'Record the exception' : 'Decline the exception'}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setMode(null)}>Back</Button>
          </div>
        </form>
      )}
      {!e.viewerCanDecide && <Alert tone="info" title="A Policy Approver decides this" detail={`Only a Policy Approver of ${e.siteName}, who is not part of the move and did not raise it, can record the exception.`} />}
    </div>
  )
}
