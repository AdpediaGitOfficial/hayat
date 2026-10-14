'use client'
/**
 * Out of office (D-32): name a stand-in and the dates. It is a record, not a grant: the stand-in must already hold an approver role
 * at your sites, gains nothing from it, and is reminded of what waits for you. It is how the system knows you are away.
 */
import { useState } from 'react'
import { Alert, Button, Field, GlassCard, Input, Textarea } from '@/ui'
import type { DelegationView } from '@/server/queries/requests/inbox'
import { Problem, useCall } from '../../requests/_components/common'

const fmt = (iso: string) => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })

export function DelegationPanel({ mine, covering, canDelegate, today }: { mine: DelegationView[]; covering: DelegationView[]; canDelegate: boolean; today: string }) {
  const { run, busy, err } = useCall()
  const [employeeId, setEmployeeId] = useState('')
  const [startsOn, setStart] = useState(today)
  const [endsOn, setEnd] = useState(today)
  const [reason, setReason] = useState('')
  const fe = err?.fields ?? {}
  return (
    <GlassCard title="Out of office" subtitle="Name a colleague who already holds your role at your sites. They gain no authority from this; they are reminded of what waits for you.">
      <div className="stack">
        {covering.map(d => <Alert key={d.id} tone="info" title={`You are covering for ${d.fromName}`} detail={`${fmt(d.startsOn)} to ${fmt(d.endsOn)}. You decide only what your own role allows.`} />)}
        {mine.map(d => (
          <div key={d.id} className="row wrap" data-testid="my-delegation">
            <Alert tone="success" title={`${d.toName} covers for you`} detail={`${fmt(d.startsOn)} to ${fmt(d.endsOn)}${d.reason ? ` · ${d.reason}` : ''}`} />
            <Button size="sm" variant="danger" disabled={busy} onClick={() => run('POST', `/api/v1/approvals/delegations/${d.id}/revoke`, undefined)}>End</Button>
          </div>
        ))}
        {canDelegate && (
          <form className="form" noValidate onSubmit={e => { e.preventDefault(); void run('POST', '/api/v1/approvals/delegations', { toEmployeeId: employeeId.trim(), startsOn, endsOn, reason: reason || null }, () => setEmployeeId('')) }}>
            {err && <Problem f={err} />}
            <Field label="Stand-in's employee ID" error={fe.toEmployeeId}><Input value={employeeId} onChange={e => setEmployeeId(e.target.value)} invalid={!!fe.toEmployeeId} autoComplete="off" /></Field>
            <div className="grid even">
              <Field label="First day away" error={fe.startsOn}><Input type="date" min={today} value={startsOn} onChange={e => setStart(e.target.value)} invalid={!!fe.startsOn} /></Field>
              <Field label="Last day away" error={fe.endsOn}><Input type="date" min={startsOn} value={endsOn} onChange={e => setEnd(e.target.value)} invalid={!!fe.endsOn} /></Field>
            </div>
            <Field label="Reason" optional><Textarea value={reason} onChange={e => setReason(e.target.value)} maxLength={300} /></Field>
            <div><Button type="submit" variant="primary" disabled={busy || !employeeId.trim()}>{busy ? 'Saving…' : 'Save stand-in'}</Button></div>
          </form>
        )}
      </div>
    </GlassCard>
  )
}
