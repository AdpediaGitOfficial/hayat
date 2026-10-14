'use client'
/**
 * Rehire (D-41): a former employee returns on their EXISTING profile (same employee ID, never a second profile). Find them, read what
 * stands in the way (a stay not checked out, an old clearance case still open), then confirm with a reason and your password.
 */
import Link from 'next/link'
import { useCallback, useEffect, useState } from 'react'
import { Alert, Badge, Blocked, Button, Check, Field, GlassCard, Input, Textarea } from '@/ui'
import { api, type ApiFail } from '@/ui/api'
import type { RehirePreview } from '@/server/queries/exit/rehire'
import type { RehireOut } from '@/server/commands/exit/rehire'
import { Problem, useCall } from './common'

export function RehireForm({ initialEmployeeId, canManageAccounts }: { initialEmployeeId?: string; canManageAccounts: boolean }) {
  const { run, busy, err, clear } = useCall()
  const [employeeId, setEmployeeId] = useState(initialEmployeeId ?? '')
  const [found, setFound] = useState<RehirePreview>()
  const [lookupErr, setLookupErr] = useState<ApiFail>()
  const [reason, setReason] = useState('')
  const [password, setPassword] = useState('')
  const [withAccount, setWithAccount] = useState(false)
  const [done, setDone] = useState<RehireOut & { message?: string }>()

  const find = useCallback(async (id: string) => {
    setFound(undefined); setLookupErr(undefined); clear()
    const r = await api<RehirePreview>('GET', `/api/v1/exit/rehire?employeeId=${encodeURIComponent(id.trim())}`)
    if (r.ok) setFound(r.data); else setLookupErr(r)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => { if (initialEmployeeId?.trim()) void find(initialEmployeeId) }, [initialEmployeeId, find])

  if (done) {
    return (
      <GlassCard title={`${done.fullName} is active again`} strong>
        <div className="stack" style={{ gap: 12 }} data-testid="rehire-done">
          <Alert tone={done.account === 'still_disabled' ? 'warning' : 'success'} title={done.message ?? 'Rehired on the existing profile'}
            detail={done.account === 'reactivated' ? undefined : done.account === 'still_disabled' ? done.accountProblem?.next : done.account === 'none' ? 'They have no login account yet.' : 'Their login stays off until it is reactivated in Users & access.'} />
          {done.temporaryPassword && (
            <Alert tone="info" title="New temporary password (shown once)" detail={<span><span className="mono" data-testid="temp-password">{done.temporaryPassword}</span> for <b>{done.username}</b>. Hand it over now: it cannot be shown again, and they must choose their own password at first sign-in.</span>} />
          )}
          <div className="row wrap"><Link href="/exits" className="btn secondary" style={{ textDecoration: 'none' }}>Back to exits</Link></div>
        </div>
      </GlassCard>
    )
  }

  const p = found?.person
  const ready = !!found?.canRehire && reason.trim().length >= 3 && password.length > 0

  return (
    <GlassCard title="Rehire" subtitle="Reactivates the existing profile. A second profile is never created." strong>
      <form className="form" noValidate onSubmit={e => {
        e.preventDefault()
        if (!p) return
        void run<RehireOut>('/api/v1/exit/rehire', { staffId: p.staffId, reason, confirmPassword: password, reactivateAccount: withAccount }, r => { setDone({ ...r.data, message: r.message }); setPassword('') })
      }}>
        {err && <Problem f={err} />}
        <Field label="Employee ID" hint="The former employee's ID: the same one as before." error={lookupErr ? (lookupErr.code === 'not_found' ? 'No staff member with that employee ID' : lookupErr.reason) : undefined}>
          <Input value={employeeId} onChange={e => { setEmployeeId(e.target.value); setFound(undefined); setLookupErr(undefined); clear() }} autoComplete="off"
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); if (employeeId.trim()) void find(employeeId) } }} />
        </Field>
        <div><Button type="button" block onClick={() => void find(employeeId)} disabled={!employeeId.trim()}>Find person</Button></div>

        {found && p && (
          <div className="stack" style={{ gap: 10 }} data-testid="rehire-preview">
            <div className="row wrap">
              <b>{p.fullName}</b><span className="muted">{p.employeeId}{p.department ? ` · ${p.department}` : ''}</span>
              <Badge tone={p.employmentStatus === 'active' ? 'success' : 'neutral'}>{p.employmentStatus === 'active' ? 'Active' : `Left${p.leftEffective ? ` ${p.leftEffective}` : ''}`}</Badge>
            </div>
            {found.blocked && <Blocked {...found.blocked} />}
            {found.blockers.length > 0 && (
              <ul className="list-plain" aria-label="Open clearance items">
                {found.blockers.map((b, i) => <li key={i} style={{ display: 'block' }}><b>{b.label}</b> <Badge tone={b.status === 'outstanding' ? 'danger' : 'warning'}>{b.status === 'outstanding' ? 'Outstanding' : 'Open'}</Badge><div className="muted body-sm">Owner: {b.owner} · Next: {b.next}</div></li>)}
              </ul>
            )}
            {found.caseId && <div><Link href={`/exits/${found.caseId}`}>Open the old clearance case</Link></div>}
          </div>
        )}

        {found?.canRehire && (
          <>
            <Field label="Reason" hint="Required: why they are returning. Kept in the audit log." error={err?.fields?.reason}>
              <Textarea value={reason} onChange={e => setReason(e.target.value)} rows={3} />
            </Field>
            {p?.hasAccount && (
              <Check checked={withAccount} onChange={setWithAccount}>Also let them sign in again (a new temporary password is issued){canManageAccounts ? '' : ' - needs an Accommodation Admin or Super Admin; otherwise do it later in Users & access'}</Check>
            )}
            <Field label="Your password" hint="Confirm it is you (D-03)." error={err?.fields?.confirmPassword}>
              <Input type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" />
            </Field>
            <div><Button variant="primary" type="submit" tall block disabled={busy || !ready}>Rehire {p?.fullName}</Button></div>
          </>
        )}
      </form>
    </GlassCard>
  )
}
