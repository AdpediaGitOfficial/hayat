'use client'
/**
 * Mark as Left (single). Phone-friendly: one column. Find the person by employee ID, read what WILL happen (the stay stays, the login
 * ends now, N reservations are cancelled ...), then confirm with an effective date, a reason and your own password (D-03).
 */
import Link from 'next/link'
import { useCallback, useEffect, useState } from 'react'
import { Alert, Badge, Blocked, Button, Field, GlassCard, Input, Textarea } from '@/ui'
import { api, type ApiFail } from '@/ui/api'
import type { ExitPreview } from '@/server/queries/exit/find'
import type { MarkLeftOut } from '@/server/commands/exit/markLeft'
import { Problem, useCall } from './common'

export function MarkLeftForm({ initialEmployeeId, today }: { initialEmployeeId?: string; today: string }) {
  const { run, busy, err, clear } = useCall()
  const [employeeId, setEmployeeId] = useState(initialEmployeeId ?? '')
  const [found, setFound] = useState<ExitPreview>()
  const [lookupErr, setLookupErr] = useState<ApiFail>()
  const [effectiveDate, setEffectiveDate] = useState(today)
  const [reason, setReason] = useState('')
  const [password, setPassword] = useState('')
  const [done, setDone] = useState<MarkLeftOut>()

  const find = useCallback(async (id: string) => {
    setFound(undefined); setLookupErr(undefined); clear()
    const r = await api<ExitPreview>('GET', `/api/v1/exit/find?employeeId=${encodeURIComponent(id.trim())}`)
    if (r.ok) setFound(r.data); else setLookupErr(r)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => { if (initialEmployeeId?.trim()) void find(initialEmployeeId) }, [initialEmployeeId, find])

  if (done) {
    return (
      <GlassCard title={`${done.fullName} is marked as Left`} strong>
        <div className="stack" style={{ gap: 12 }} data-testid="mark-left-done">
          <Alert tone="success" title="Done. The login has ended and the clearance case is open"
            detail={`${done.accountRevoked ? `Signed out of ${done.sessionsEnded} session${done.sessionsEnded === 1 ? '' : 's'}. ` : ''}${done.stillInBed ? 'They stay in the bed until an actual checkout; the bed is not released. ' : ''}Clearance is due ${done.dueDate}.`} />
          <ul className="list-plain" aria-label="What was done">
            <li>Future reservations cancelled: <b>{done.cascade.reservationsCancelled}</b></li>
            <li>Waitlist entries closed: <b>{done.cascade.waitlistEntriesClosed}</b>, offers withdrawn: <b>{done.cascade.offersWithdrawn}</b></li>
            <li>Open requests cancelled: <b>{done.cascade.requestsCancelled}</b>, moves, extensions and checkout requests: <b>{done.cascade.transfersCancelled + done.cascade.extensionsCancelled + done.cascade.checkoutRequestsCancelled}</b></li>
            <li>Clearance items opened: <b>{done.itemsOpened}</b></li>
          </ul>
          <div className="row wrap">
            <Link href={`/exits/${done.caseId}`} className="btn primary" style={{ textDecoration: 'none' }}>Open the clearance case</Link>
            <Button onClick={() => { setDone(undefined); setFound(undefined); setEmployeeId(''); setReason(''); setPassword('') }}>Mark another person</Button>
          </div>
        </div>
      </GlassCard>
    )
  }

  const p = found?.person
  const ready = !!found?.canMark && reason.trim().length >= 3 && /^\d{4}-\d{2}-\d{2}$/.test(effectiveDate) && password.length > 0

  return (
    <GlassCard title="Mark as Left" subtitle="The employee has left the organisation. Their login ends now; they stay in the bed until an actual checkout." strong>
      <form className="form" noValidate onSubmit={e => {
        e.preventDefault()
        if (!p) return
        void run<MarkLeftOut>('/api/v1/exit', { staffId: p.staffId, effectiveDate, reason, confirmPassword: password }, r => { setDone(r.data); setPassword('') })
      }}>
        {err && <Problem f={err} />}
        <Field label="Employee ID" hint="The person's employee ID, exactly." error={lookupErr ? (lookupErr.code === 'not_found' ? 'No staff member with that employee ID, or not one of yours' : lookupErr.reason) : undefined}>
          <Input value={employeeId} onChange={e => { setEmployeeId(e.target.value); setFound(undefined); setLookupErr(undefined); clear() }} autoComplete="off" placeholder="E1007"
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); if (employeeId.trim()) void find(employeeId) } }} />
        </Field>
        <div><Button type="button" block onClick={() => void find(employeeId)} disabled={!employeeId.trim()}>Find person</Button></div>

        {found && p && (
          <div className="stack" style={{ gap: 10 }} data-testid="exit-preview">
            <div className="row wrap">
              <b>{p.fullName}</b><span className="muted">{p.employeeId}{p.department ? ` · ${p.department}` : ''}</span>
              <Badge tone={p.employmentStatus === 'active' ? 'success' : 'neutral'}>{p.employmentStatus === 'active' ? 'Active' : 'Left'}</Badge>
            </div>
            {found.blocked
              ? (
                <>
                  <Blocked {...found.blocked} />
                  {found.existingCaseId && <div><Link href={`/exits/${found.existingCaseId}`}>Open the clearance case</Link></div>}
                </>
              )
              : (
                <Alert tone="warning" title="What will happen"
                  detail={<ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>{found.willHappen.map((l, i) => <li key={i}>{l}</li>)}</ul>} />
              )}
          </div>
        )}

        {found?.canMark && (
          <>
            <Field label="Effective date" hint="The day they leave. The login ends now whatever the date: a notice-period rule (D-37) is still open." error={err?.fields?.effectiveDate}>
              <Input type="date" value={effectiveDate} onChange={e => setEffectiveDate(e.target.value)} />
            </Field>
            <Field label="Reason" hint="Required. It goes on the clearance case and the audit log." error={err?.fields?.reason}>
              <Textarea value={reason} onChange={e => setReason(e.target.value)} rows={3} />
            </Field>
            <Field label="Your password" hint="Confirm it is you (D-03). This ends someone's access." error={err?.fields?.confirmPassword}>
              <Input type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" />
            </Field>
            <div><Button variant="danger" type="submit" tall block disabled={busy || !ready}>Mark {p?.fullName} as Left</Button></div>
          </>
        )}
      </form>
    </GlassCard>
  )
}
