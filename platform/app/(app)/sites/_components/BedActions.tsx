'use client'
/** Block and unblock a bed. A block needs a reason; "until" is the LAST blocked day (D-103). Reservations are never moved. */
import { useState } from 'react'
import { Alert, Blocked, Button, Field, GlassCard, Input, Textarea } from '@/ui'
import type { BlockBedOut } from '@/server/commands/property/blockBed'
import { fmtClaimRange } from './state'
import { Problem, useCall } from './common'
import type { BedStateDb } from '@/domain/enums'

export function BedActions({ bedId, code, state, today, canBlock }: { bedId: string; code: string; state: BedStateDb; today: string; canBlock: boolean }) {
  const { run, busy, err } = useCall()
  const [reason, setReason] = useState('')
  const [until, setUntil] = useState('')
  const [note, setNote] = useState('')
  const [result, setResult] = useState<BlockBedOut>()

  if (!canBlock) return null
  if (state === 'archived') return null

  // The outcome of a block stays on screen after the page data refreshes (the bed is blocked by then, so the form is gone).
  const outcome = result ? <GlassCard title="Bookings on this bed"><BlockResult result={result} /></GlassCard> : null

  if (state === 'blocked') {
    return (
      <>
      {outcome}
      <GlassCard title="Unblock" subtitle="The bed then goes to Needs cleaning and must pass the final inspection before check-in">
        <form className="form" onSubmit={e => { e.preventDefault(); void run('POST', `/api/v1/property/beds/${bedId}/unblock`, { note }, () => setResult(undefined)) }} noValidate>
          {err && <Problem f={err} />}
          <Field label="Note" hint="What was fixed? Goes into the audit log." optional error={err?.fields?.note}><Textarea value={note} onChange={e => setNote(e.target.value)} /></Field>
          <div><Button variant="primary" type="submit" disabled={busy}>Unblock bed {code}</Button></div>
        </form>
      </GlassCard>
      </>
    )
  }

  if (state === 'occupied') {
    return (
      <GlassCard title="Block">
        <Blocked why="Occupied beds can't be blocked" owner="Accommodation Admin" next="Check the resident out or transfer them to another bed first; nobody is moved automatically" />
      </GlassCard>
    )
  }

  return (
    <GlassCard title="Block" subtitle="A blocked bed cannot be allocated. Existing reservations stay and are shown to you; nobody is moved.">
      <form className="form" noValidate onSubmit={e => {
        e.preventDefault()
        void run<BlockBedOut>('POST', `/api/v1/property/beds/${bedId}/block`, { reason, until: until || null }, r => { setResult(r.data); setReason(''); setUntil('') })
      }}>
        {err && <Problem f={err} />}
        <Field label="Reason to block" hint="Required." error={err?.fields?.reason}><Textarea value={reason} onChange={e => setReason(e.target.value)} /></Field>
        <Field label="Until" hint={`The last blocked day. Leave empty for further notice. Today is ${today}.`} optional error={err?.fields?.until}>
          <Input type="date" min={today} value={until} onChange={e => setUntil(e.target.value)} />
        </Field>
        <div><Button variant="primary" type="submit" disabled={busy || reason.trim().length < 3}>Block bed {code}</Button></div>
      </form>
    </GlassCard>
  )
}

function BlockResult({ result }: { result: BlockBedOut }) {
  const affected = result.upcomingClaims.filter(c => c.overlapsBlock)
  if (result.upcomingClaims.length === 0) return <p className="muted body-sm">No reservations are booked on this bed.</p>
  return (
    <div className="stack">
      <Alert tone={affected.length ? 'warning' : 'info'}
        title={affected.length ? `${affected.length} booking${affected.length > 1 ? 's' : ''} fall inside the block` : 'Bookings are not affected by the block dates'}
        detail="Nobody was cancelled or moved. Review them and cancel, move or let them stand." />
      <ul className="list-plain">
        {result.upcomingClaims.map(c => (
          <li key={c.claimId}><span style={{ flex: 1 }}>{fmtClaimRange(c.from, c.to)}</span><span className="muted body-sm">{c.kind.replace('_', ' ')}{c.overlapsBlock ? ' · inside the block' : ''}</span></li>
        ))}
      </ul>
    </div>
  )
}
