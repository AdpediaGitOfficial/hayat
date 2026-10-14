'use client'
/** An Accommodation Admin proposes that two residents exchange beds. Consent is recorded per resident (how they agreed) or left for them to confirm. */
import { useState } from 'react'
import { Button, Field, GlassCard, Select, Textarea } from '@/ui'
import { Problem, useCall } from './call'

export interface SwapChoice { stayId: string; label: string }
type Via = '' | 'in_person' | 'phone' | 'written'

export function SwapForm({ choices }: { choices: SwapChoice[] }) {
  const { run, busy, err } = useCall()
  const [a, setA] = useState('')
  const [b, setB] = useState('')
  const [reason, setReason] = useState('')
  const [ca, setCa] = useState<Via>('')
  const [cb, setCb] = useState<Via>('')
  const consent = (v: Via) => (v ? { via: v, note: null } : null)
  const label = (id: string) => choices.find(c => c.stayId === id)?.label ?? 'the resident'
  return (
    <GlassCard title="Propose a bed swap" subtitle="Two residents exchange beds in one step. Both must agree; a second Accommodation Admin approves; Reception carries it out. If either move is refused, neither resident moves.">
      <form className="form" noValidate onSubmit={e => { e.preventDefault(); void run('/api/v1/stays/swaps', { stayId: a, otherStayId: b, reason, consentFirst: consent(ca), consentSecond: consent(cb) }, () => { setReason(''); setA(''); setB(''); setCa(''); setCb('') }) }}>
        {err && <Problem f={err} />}
        <Field label="First resident" error={err?.fields?.stayId}>
          <Select value={a} onChange={e => setA(e.target.value)}><option value="">Choose a stay</option>{choices.map(c => <option key={c.stayId} value={c.stayId}>{c.label}</option>)}</Select>
        </Field>
        <Field label="Second resident" error={err?.fields?.otherStayId}>
          <Select value={b} onChange={e => setB(e.target.value)}><option value="">Choose a stay</option>{choices.filter(c => c.stayId !== a).map(c => <option key={c.stayId} value={c.stayId}>{c.label}</option>)}</Select>
        </Field>
        <Field label={`Has ${a ? label(a) : 'the first resident'} agreed?`} hint="Leave on 'Not yet' and they confirm in the app." optional>
          <Select value={ca} onChange={e => setCa(e.target.value as Via)}><option value="">Not yet</option><option value="in_person">Yes, in person</option><option value="phone">Yes, by phone</option><option value="written">Yes, in writing</option></Select>
        </Field>
        <Field label={`Has ${b ? label(b) : 'the second resident'} agreed?`} optional>
          <Select value={cb} onChange={e => setCb(e.target.value as Via)}><option value="">Not yet</option><option value="in_person">Yes, in person</option><option value="phone">Yes, by phone</option><option value="written">Yes, in writing</option></Select>
        </Field>
        <Field label="Reason" error={err?.fields?.reason}><Textarea value={reason} onChange={e => setReason(e.target.value)} /></Field>
        <div><Button variant="primary" type="submit" disabled={busy || !a || !b || reason.trim().length < 3}>Propose swap</Button></div>
      </form>
    </GlassCard>
  )
}
