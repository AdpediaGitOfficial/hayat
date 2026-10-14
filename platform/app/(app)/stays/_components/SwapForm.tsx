'use client'
/**
 * An Accommodation Admin proposes that two residents exchange beds. Consent is recorded per resident (how they agreed) or left for them to confirm.
 *
 * Two proposals pending client sign-off show up here only when their setting is on (the server checks both again):
 *  - P-11: name the other resident by EMPLOYEE ID, also at another site. "Check" shows the name and the site of an active stay, nothing else;
 *    anyone who is not an active resident gets the same answer as an unknown ID.
 *  - P-10: if the swap fails a gender or grade rule of the other site, ask a Policy Approver for an exception instead of stopping.
 */
import { useState } from 'react'
import { Alert, Button, Field, GlassCard, Input, Select, Textarea } from '@/ui'
import { api } from '@/ui/api'
import type { SwapPartnerOut } from '@/server/commands/stays/swapPartner'
import { Problem, useCall } from './call'

export interface SwapChoice { stayId: string; label: string }
type Via = '' | 'in_person' | 'phone' | 'written'

export function SwapForm({ choices, partnerLookup = false, exceptionPath = false }: { choices: SwapChoice[]; partnerLookup?: boolean; exceptionPath?: boolean }) {
  const { run, busy, err } = useCall()
  const [a, setA] = useState('')
  const [b, setB] = useState('')
  const [byId, setById] = useState(false)
  const [employeeId, setEmployeeId] = useState('')
  const [found, setFound] = useState<SwapPartnerOut>()
  const [lookupMsg, setLookupMsg] = useState<string>()
  const [looking, setLooking] = useState(false)
  const [reason, setReason] = useState('')
  const [ca, setCa] = useState<Via>('')
  const [cb, setCb] = useState<Via>('')
  const consent = (v: Via) => (v ? { via: v, note: null } : null)
  const label = (id: string) => choices.find(c => c.stayId === id)?.label ?? 'the resident'
  const second = byId ? (found ? `${found.name} (${found.siteName})` : 'the second resident') : (b ? label(b) : 'the second resident')
  const canAsk = exceptionPath && (err?.detail as { canAskException?: boolean } | undefined)?.canAskException === true

  async function check() {
    setLooking(true); setFound(undefined); setLookupMsg(undefined)
    const r = await api<SwapPartnerOut>('POST', '/api/v1/stays/swap-partner', { employeeId })
    setLooking(false)
    if (r.ok) setFound(r.data); else setLookupMsg(`${r.reason}${r.next ? `. ${r.next}` : ''}`)
  }
  const body = (askException: boolean) => ({
    stayId: a, ...(byId ? { otherEmployeeId: employeeId } : { otherStayId: b }), reason, consentFirst: consent(ca), consentSecond: consent(cb), ...(askException ? { askException: true } : {}),
  })
  const reset = () => { setReason(''); setA(''); setB(''); setCa(''); setCb(''); setEmployeeId(''); setFound(undefined); setLookupMsg(undefined) }

  return (
    <GlassCard title="Propose a bed swap" subtitle="Two residents exchange beds in one step. Both must agree; a second Accommodation Admin approves; Reception carries it out. If either move is refused, neither resident moves.">
      <form className="form" noValidate onSubmit={e => { e.preventDefault(); void run('/api/v1/stays/swaps', body(false), reset) }}>
        {err && <Problem f={err} />}
        {canAsk && (
          <Alert tone="warning" title="A Policy Approver can be asked for an exception"
            detail="Proposed policy, pending client sign-off. The swap is recorded and waits for their decision; it cannot be approved before."
            action={<Button size="sm" disabled={busy} onClick={() => void run('/api/v1/stays/swaps', body(true), reset)}>Ask a Policy Approver</Button>} />
        )}
        <Field label="First resident" error={err?.fields?.stayId}>
          <Select value={a} onChange={e => setA(e.target.value)}><option value="">Choose a stay</option>{choices.map(c => <option key={c.stayId} value={c.stayId}>{c.label}</option>)}</Select>
        </Field>
        {partnerLookup && (
          <label className="row" style={{ gap: 8 }}>
            <input type="checkbox" checked={byId} onChange={e => { setById(e.target.checked); setFound(undefined); setLookupMsg(undefined) }} />
            <span>The second resident is at another site: find them by employee ID <span className="muted body-sm">(proposed policy, pending client sign-off)</span></span>
          </label>
        )}
        {!byId && (
          <Field label="Second resident" error={err?.fields?.otherStayId}>
            <Select value={b} onChange={e => setB(e.target.value)}><option value="">Choose a stay</option>{choices.filter(c => c.stayId !== a).map(c => <option key={c.stayId} value={c.stayId}>{c.label}</option>)}</Select>
          </Field>
        )}
        {byId && (
          <Field label="Second resident's employee ID" hint="Only the name and the site of an active stay are shown." error={err?.fields?.otherEmployeeId}>
            <div className="row wrap">
              <Input value={employeeId} onChange={e => { setEmployeeId(e.target.value); setFound(undefined); setLookupMsg(undefined) }} style={{ maxWidth: 220 }} />
              <Button size="sm" disabled={looking || !employeeId.trim()} onClick={() => void check()}>Check</Button>
            </div>
            {found && <p className="body-sm" data-testid="partner-found" style={{ margin: '6px 0 0' }}><b>{found.name}</b> · {found.siteName}</p>}
            {lookupMsg && <p className="body-sm" data-testid="partner-missing" style={{ margin: '6px 0 0' }}>{lookupMsg}</p>}
          </Field>
        )}
        <Field label={`Has ${a ? label(a) : 'the first resident'} agreed?`} hint="Leave on 'Not yet' and they confirm in the app." optional>
          <Select value={ca} onChange={e => setCa(e.target.value as Via)}><option value="">Not yet</option><option value="in_person">Yes, in person</option><option value="phone">Yes, by phone</option><option value="written">Yes, in writing</option></Select>
        </Field>
        <Field label={`Has ${second} agreed?`} optional>
          <Select value={cb} onChange={e => setCb(e.target.value as Via)}><option value="">Not yet</option><option value="in_person">Yes, in person</option><option value="phone">Yes, by phone</option><option value="written">Yes, in writing</option></Select>
        </Field>
        <Field label="Reason" error={err?.fields?.reason}><Textarea value={reason} onChange={e => setReason(e.target.value)} /></Field>
        <div><Button variant="primary" type="submit" disabled={busy || !a || (byId ? !found : !b) || reason.trim().length < 3}>Propose swap</Button></div>
      </form>
    </GlassCard>
  )
}
