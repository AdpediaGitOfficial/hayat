'use client'
/**
 * Start an emergency check-in. Phone-first: one column, big targets. Find the person by employee ID, pick a free bed in your
 * own sites, say what happened. The stay is Provisional until a person decides; eligibility is the approver's call.
 */
import { useCallback, useEffect, useState } from 'react'
import { Alert, Badge, Blocked, Button, ConfirmPassword, Field, GlassCard, Input, Select, Textarea } from '@/ui'
import { api, type ApiFail } from '@/ui/api'
import type { BedChoice, PersonHit } from '@/server/queries/emergency/pick'
import type { InitiateOut } from '@/server/commands/emergency/initiate'
import { Problem, useCall } from './common'

export function InitiateForm({ approver, deadlineHours, needsPassword = false }: { approver: string; deadlineHours: number; needsPassword?: boolean }) {
  const { run, busy, err, clearError } = useCall()
  const [employeeId, setEmployeeId] = useState('')
  const [person, setPerson] = useState<PersonHit>()
  const [lookupErr, setLookupErr] = useState<ApiFail>()
  const [beds, setBeds] = useState<BedChoice[]>([])
  const [bedsErr, setBedsErr] = useState<ApiFail>()
  const [q, setQ] = useState('')
  const [bedId, setBedId] = useState('')
  const [reason, setReason] = useState('')
  const [days, setDays] = useState('')
  const [password, setPassword] = useState('')
  const [done, setDone] = useState<InitiateOut>()

  const loadBeds = useCallback(async (search: string) => {
    const r = await api<BedChoice[]>('GET', `/api/v1/emergency/beds${search ? `?q=${encodeURIComponent(search)}` : ''}`)
    if (r.ok) { setBeds(r.data); setBedsErr(undefined) } else setBedsErr(r)
  }, [])
  useEffect(() => { void loadBeds('') }, [loadBeds])

  async function find() {
    setPerson(undefined); setLookupErr(undefined)
    const r = await api<PersonHit>('GET', `/api/v1/emergency/staff?employeeId=${encodeURIComponent(employeeId.trim())}`)
    if (r.ok) setPerson(r.data); else setLookupErr(r)
  }

  const personBlock = person
    ? person.isSelf ? { why: 'You cannot start an emergency check-in for yourself', owner: 'Another Emergency Check-in holder', next: 'Ask a colleague to do it' }
      : person.employmentStatus !== 'active' ? { why: `${person.fullName} is not an active employee`, owner: 'Accommodation Admin', next: 'Check the staff record' }
        : person.hasStay ? { why: `${person.fullName} already has a stay`, owner: 'Accommodation Admin', next: 'Open the stay. Moving someone is a transfer' }
          : undefined
    : undefined
  const ready = !!person && !personBlock && !!bedId && reason.trim().length >= 3 && (!needsPassword || password.length > 0)

  if (done) {
    return (
      <GlassCard title="Provisional stay created" strong>
        <div className="stack" style={{ gap: 12 }}>
          <Alert tone="success" title={`In bed ${done.bedCode}. Status: Provisional`}
            detail={`${approver} must decide by ${done.deadlineAt.slice(0, 16).replace('T', ' ')} UTC. It is reminded and escalated if nobody does. Nothing is approved or undone automatically.`} />
          {!done.eligibility.ok && <Alert tone="warning" title="Rules that would have failed" detail={done.eligibility.reasons.join('; ')} />}
          <div className="row wrap"><a className="btn secondary" href={`/emergency/${done.caseId}`}>Open the case</a><Button onClick={() => { setDone(undefined); setPerson(undefined); setEmployeeId(''); setBedId(''); setReason(''); setDays(''); setPassword('') }}>Start another</Button></div>
        </div>
      </GlassCard>
    )
  }

  return (
    <GlassCard title="Start an emergency check-in" subtitle={`A provisional stay now. ${approver} decides within ${deadlineHours} hours.`} strong>
      <form className="form" noValidate onSubmit={e => {
        e.preventDefault()
        if (!person) return
        void run<InitiateOut>('POST', '/api/v1/emergency', { staffId: person.id, bedId, reason, expectedDays: days ? Number(days) : null, ...(needsPassword ? { confirmPassword: password } : {}) }, r => { setPassword(''); setDone(r.data) })
      }}>
        {err && <Problem f={err} />}
        <Field label="Employee ID" hint="The person's employee ID, exactly." error={lookupErr ? (lookupErr.code === 'not_found' ? 'No staff member with that employee ID' : lookupErr.reason) : undefined}>
          <Input value={employeeId} onChange={e => { setEmployeeId(e.target.value); setPerson(undefined); setLookupErr(undefined); clearError() }} autoComplete="off" placeholder="E1007"
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); if (employeeId.trim()) void find() } }} />
        </Field>
        <div><Button type="button" block onClick={() => void find()} disabled={!employeeId.trim()}>Find person</Button></div>
        {person && (
          <div className="stack" style={{ gap: 8 }} data-testid="person-card">
            <div className="row wrap"><b>{person.fullName}</b><span className="muted">{person.employeeId}{person.department ? ` · ${person.department}` : ''}</span><Badge tone={person.employmentStatus === 'active' ? 'success' : 'neutral'}>{person.employmentStatus === 'active' ? 'Active' : 'Left'}</Badge></div>
            {personBlock && <Blocked {...personBlock} />}
          </div>
        )}

        <Field label="Find a bed" hint="Available beds in your sites with nothing booked over today. Type to narrow the list.">
          <Input value={q} onChange={e => { setQ(e.target.value); void loadBeds(e.target.value) }} placeholder="Bed or room" />
        </Field>
        {bedsErr && <Problem f={bedsErr} />}
        <Field label="Bed">
          <Select value={bedId} onChange={e => setBedId(e.target.value)}>
            <option value="">{beds.length ? 'Choose a bed' : 'No free bed found'}</option>
            {beds.map(b => <option key={b.id} value={b.id}>{b.siteName} · {b.buildingName ? `${b.buildingName} · ` : ''}{b.roomName} · {b.code}{b.nextClaimFrom ? ` (booked from ${b.nextClaimFrom})` : ''}</option>)}
          </Select>
        </Field>
        {beds.length === 0 && !bedsErr && <Blocked why="No Available bed with nothing booked over today in your sites" owner="Accommodation Admin" next="Ask for a bed to be released, or for a bed that needs cleaning to be finished first" />}

        <Field label="What happened?" hint="Required. The approver reads this." error={err?.fields?.reason}>
          <Textarea value={reason} onChange={e => setReason(e.target.value)} rows={3} />
        </Field>
        <Field label="Expected days" optional hint="Leave empty if you do not know yet." error={err?.fields?.expectedDays}>
          <Input type="number" min={1} max={365} inputMode="numeric" value={days} onChange={e => setDays(e.target.value)} />
        </Field>
        {needsPassword && <ConfirmPassword value={password} onChange={setPassword} error={err?.fields?.confirmPassword} />}
        <Alert tone="info" title={`Goes to: ${approver}`} detail="You started it, so you can never approve it. Eligibility is the approver's call; they will see any rule that would have failed." />
        <div><Button variant="primary" type="submit" tall block disabled={busy || !ready}>Create provisional stay</Button></div>
      </form>
    </GlassCard>
  )
}
