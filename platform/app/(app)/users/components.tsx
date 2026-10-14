'use client'
/** Interactive pieces of the Users & access screens. Every failure shows reason + owner + next action (D-93). */
import { useRouter } from 'next/navigation'
import { useState, type ReactNode } from 'react'
import { Alert, Button, ConfirmPassword, Field, Input, Select, Textarea, useToast } from '@/ui'
import { Modal } from './portal-modal'
import { post, type ApiFail, type ApiResult } from '@/ui/api'
import { ROLES, CAPABILITIES, type Capability, type Role, type ScopeKind } from '@/domain/enums'
import { CAP_LABEL, ROLE_LABEL } from '@/domain/labels'
import { CAPABILITY_HINT, ROLE_SCOPE_KINDS, SCOPE_LABEL } from '@/server/commands/access/rules'

export interface SiteOpt { id: string; code: string; name: string }
export interface BuildingOpt { id: string; label: string }

export function Problem({ f }: { f: ApiFail }) {
  const detail = [f.owner && `Owner: ${f.owner}`, f.next && `Next: ${f.next}`].filter(Boolean).join(' · ')
  return <Alert tone="danger" title={f.reason} detail={detail || undefined} />
}

/* ---------------------------------------------------------------- the one-time password */

export function TempPasswordDialog({ title, username, password, onDone }: { title: string; username: string; password: string; onDone: () => void }) {
  const toast = useToast()
  const [copied, setCopied] = useState(false)
  async function copy() {
    try { await navigator.clipboard.writeText(password); setCopied(true) } catch { toast('Could not copy. Select the password and copy it by hand', true) }
  }
  const close = () => { if (copied || window.confirm('Close without copying? This password cannot be shown again.')) onDone() }
  return (
    <Modal open onClose={close} title={title} subtitle="Shown once, now"
      footer={<><Button icon="clipboard" onClick={copy}>{copied ? 'Copied' : 'Copy password'}</Button><Button variant="primary" onClick={onDone}>I have handed it over</Button></>}>
      <Alert tone="warning" title="This password cannot be shown again"
        detail="Only a one-way hash is kept, so nobody can look it up later. Hand it over through the approved offline process (D-07). The person must choose their own password the first time they sign in." />
      <dl className="kv" style={{ marginTop: 16 }}>
        <dt>Username</dt><dd className="mono">{username}</dd>
        <dt>Temporary password</dt>
        <dd><code className="mono" data-testid="temp-password" style={{ fontSize: 20, userSelect: 'all', letterSpacing: '.08em' }}>{password}</code></dd>
      </dl>
    </Modal>
  )
}

/* ---------------------------------------------------------------- a reason, then do it */

function ReasonModal({ title, subtitle, confirm, danger, required = true, label = 'Reason', needsPassword = false, onClose, run }: {
  title: string; subtitle?: ReactNode; confirm: string; danger?: boolean; required?: boolean; label?: string
  /** D-03 / P-02 (proposed, pending client sign-off): ask for the password again; the value is passed to `run` as `confirmPassword`. */
  needsPassword?: boolean
  onClose: () => void; run: (reason: string, confirmPassword?: string) => Promise<ApiResult<unknown>>
}) {
  const [reason, setReason] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<ApiFail>()
  async function go() {
    setBusy(true); setErr(undefined)
    const r = await run(reason.trim(), needsPassword ? password : undefined)
    setBusy(false)
    if (!r.ok) setErr(r)
  }
  return (
    <Modal open onClose={onClose} title={title} subtitle={subtitle}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant={danger ? 'danger' : 'primary'} onClick={go} disabled={busy || (required && !reason.trim()) || (needsPassword && !password)}>{busy ? 'Working…' : confirm}</Button></>}>
      {err && <Problem f={err} />}
      <Field label={label} optional={!required} error={err?.fields?.reason}><Textarea value={reason} onChange={e => setReason(e.target.value)} rows={3} autoFocus /></Field>
      {needsPassword && <ConfirmPassword value={password} onChange={setPassword} error={err?.fields?.confirmPassword} />}
    </Modal>
  )
}

type Action = 'reset' | 'deactivate' | 'reactivate' | 'sessions'
interface Issued { title: string; username: string; password: string }

export function AccountActions({ userId, username, status, manageable, why }: { userId: string; username: string; status: string; manageable: boolean; why?: string }) {
  const router = useRouter()
  const toast = useToast()
  const [action, setAction] = useState<Action>()
  const [issued, setIssued] = useState<Issued>()
  const revoked = status === 'revoked'
  const base = `/api/v1/access/users/${userId}`

  if (!manageable) return why ? <div style={{ maxWidth: 420 }}><span className="muted body-sm">{why}</span></div> : null

  async function run(path: string, reason: string, kind: Action) {
    const r = await post<{ temporaryPassword?: string; username?: string }>(`${base}/${path}`, { reason: reason || undefined })
    if (!r.ok) return r
    setAction(undefined)
    if (r.data.temporaryPassword) setIssued({ title: kind === 'reactivate' ? 'Account reactivated' : 'Password reset', username: r.data.username ?? username, password: r.data.temporaryPassword })
    else { toast(r.message ?? 'Done'); router.refresh() }
    return r
  }
  return (
    <>
      <div className="row wrap">
        {!revoked && <Button icon="key" onClick={() => setAction('reset')}>Reset password</Button>}
        {!revoked && <Button icon="exit" onClick={() => setAction('sessions')}>End all sessions</Button>}
        {!revoked && <Button variant="danger" icon="ban" onClick={() => setAction('deactivate')}>Deactivate</Button>}
        {revoked && <Button variant="primary" icon="undo" onClick={() => setAction('reactivate')}>Reactivate</Button>}
      </div>
      {action === 'reset' && <ReasonModal title="Reset this password" subtitle="A new temporary password is shown once. Every session of this person ends now." confirm="Reset and show password" required={false} label="Reason" onClose={() => setAction(undefined)} run={r => run('reset-password', r, 'reset')} />}
      {action === 'sessions' && <ReasonModal title="End all sessions" subtitle="They are signed out everywhere at once. Their account stays active." confirm="End all sessions" danger onClose={() => setAction(undefined)} run={r => run('revoke-sessions', r, 'sessions')} />}
      {action === 'deactivate' && <ReasonModal title="Deactivate this account" subtitle="The login stops working immediately. A bed is not freed by this; only an actual checkout does that." confirm="Deactivate" danger onClose={() => setAction(undefined)} run={r => run('deactivate', r, 'deactivate')} />}
      {action === 'reactivate' && <ReasonModal title="Reactivate this account" subtitle="They get a NEW temporary password (the old one does not come back) and must change it at first sign-in." confirm="Reactivate and show password" onClose={() => setAction(undefined)} run={r => run('reactivate', r, 'reactivate')} />}
      {issued && <TempPasswordDialog {...issued} onDone={() => { setIssued(undefined); router.refresh() }} />}
    </>
  )
}

/* ---------------------------------------------------------------- a role + scope picker */

export interface RoleSpecValue { role: Role; scopeKind: ScopeKind; siteId: string; buildingId: string }
export const initialSpec = (): RoleSpecValue => ({ role: 'Rec', scopeKind: 'site', siteId: '', buildingId: '' })
export function specBody(v: RoleSpecValue) {
  return { role: v.role, scopeKind: v.scopeKind, siteId: v.scopeKind === 'site' ? v.siteId || undefined : undefined, buildingId: v.scopeKind === 'building' ? v.buildingId || undefined : undefined }
}

export function RoleSpecFields({ value, onChange, sites, buildings, errors }: {
  value: RoleSpecValue; onChange: (v: RoleSpecValue) => void; sites: SiteOpt[]; buildings: BuildingOpt[]; errors?: Record<string, string>
}) {
  const kinds = ROLE_SCOPE_KINDS[value.role]
  return (
    <>
      <Field label="Role" error={errors?.role}>
        <Select value={value.role} onChange={e => {
          const role = e.target.value as Role
          const k = ROLE_SCOPE_KINDS[role]
          onChange({ ...value, role, scopeKind: k.includes('site') ? 'site' : k[0] })
        }}>{ROLES.map(r => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}</Select>
      </Field>
      <Field label="Scope" error={errors?.scopeKind} hint={kinds.length === 1 ? 'This role has only one possible scope' : undefined}>
        <Select value={value.scopeKind} onChange={e => onChange({ ...value, scopeKind: e.target.value as ScopeKind })}>
          {kinds.map(k => <option key={k} value={k}>{SCOPE_LABEL[k]}</option>)}
        </Select>
      </Field>
      {value.scopeKind === 'site' && (
        <Field label="Site" error={errors?.siteId}>
          <Select value={value.siteId} onChange={e => onChange({ ...value, siteId: e.target.value })}>
            <option value="">Choose a site…</option>{sites.map(s => <option key={s.id} value={s.id}>{s.code} · {s.name}</option>)}
          </Select>
        </Field>
      )}
      {value.scopeKind === 'building' && (
        <>
          <Field label="Building" error={errors?.buildingId}>
            <Select value={value.buildingId} onChange={e => onChange({ ...value, buildingId: e.target.value })}>
              <option value="">Choose a building…</option>{buildings.map(b => <option key={b.id} value={b.id}>{b.label}</option>)}
            </Select>
          </Field>
          <Alert tone="info" title="A building scope gives no site scope yet (S-6)" detail="The person will not see site-level data through it. Add a site scope as well if they need that." />
        </>
      )}
    </>
  )
}

/* ---------------------------------------------------------------- create an account */

export function NewAccountButton({ sites, buildings, canRequestRole, siteRequired, needsRolePassword = false }: { sites: SiteOpt[]; buildings: BuildingOpt[]; canRequestRole: boolean; siteRequired: boolean; needsRolePassword?: boolean }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [employeeId, setEmployeeId] = useState('')
  const [username, setUsername] = useState('')
  const [siteId, setSiteId] = useState(sites.length === 1 ? sites[0].id : '')
  const [reason, setReason] = useState('')
  const [withRole, setWithRole] = useState(false)
  const [spec, setSpec] = useState<RoleSpecValue>(initialSpec())
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<ApiFail>()
  const [issued, setIssued] = useState<Issued & { pending?: boolean }>()

  async function submit() {
    setBusy(true); setErr(undefined)
    const r = await post<{ temporaryPassword: string; username: string; roleChangeRequestId?: string }>('/api/v1/access/users', {
      employeeId: employeeId.trim(), username: username.trim() || undefined, siteId: siteId || undefined, reason: reason.trim() || undefined,
      initialRole: withRole ? specBody(spec) : undefined,
      ...(withRole && needsRolePassword ? { confirmPassword: password } : {}),
    })
    setBusy(false)
    if (!r.ok) return setErr(r)
    setOpen(false)
    setIssued({ title: 'Account created', username: r.data.username, password: r.data.temporaryPassword, pending: !!r.data.roleChangeRequestId })
    setEmployeeId(''); setUsername(''); setReason(''); setWithRole(false); setPassword('')
  }
  const needSite = siteRequired && !siteId
  return (
    <>
      <Button variant="primary" icon="userPlus" onClick={() => setOpen(true)}>New account</Button>
      {open && (
        <Modal open onClose={() => setOpen(false)} title="New account" subtitle="For someone who already has a staff record. They sign in with a temporary password and must change it."
          footer={<><Button onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" onClick={submit} disabled={busy || !employeeId.trim() || needSite || (withRole && (!reason.trim() || (needsRolePassword && !password)))}>{busy ? 'Creating…' : 'Create account'}</Button></>}>
          {err && <Problem f={err} />}
          <Field label="Employee ID" error={err?.fields?.employeeId} hint="The staff record must exist first (Staff)."><Input value={employeeId} onChange={e => setEmployeeId(e.target.value)} autoFocus autoCapitalize="none" /></Field>
          <Field label="Username" optional hint="Defaults to the employee ID" error={err?.fields?.username}><Input value={username} onChange={e => setUsername(e.target.value)} autoCapitalize="none" /></Field>
          <Field label="Site" optional={!siteRequired} error={err?.fields?.siteId} hint="Where this person lives or works. It decides which Accommodation Admins can manage the account.">
            <Select value={siteId} onChange={e => setSiteId(e.target.value)}>
              <option value="">{siteRequired ? 'Choose a site…' : 'No site'}</option>{sites.map(s => <option key={s.id} value={s.id}>{s.code} · {s.name}</option>)}
            </Select>
          </Field>
          <Alert tone="info" title="They start as a Resident" detail="The base Resident role (own record only) comes with every account. Anything beyond that is a role change and needs a second Super Admin." />
          {canRequestRole && (
            <>
              <label className="check" style={{ marginTop: 12 }}><input type="checkbox" checked={withRole} onChange={e => setWithRole(e.target.checked)} /> Also request another role now</label>
              {withRole && <RoleSpecFields value={spec} onChange={setSpec} sites={sites} buildings={buildings} errors={err?.fields} />}
            </>
          )}
          <Field label="Reason" optional={!withRole} error={err?.fields?.reason}><Textarea value={reason} onChange={e => setReason(e.target.value)} rows={2} /></Field>
          {withRole && needsRolePassword && <ConfirmPassword value={password} onChange={setPassword} error={err?.fields?.confirmPassword} />}
        </Modal>
      )}
      {issued && <TempPasswordDialog {...issued} onDone={() => { setIssued(undefined); router.refresh() }} />}
    </>
  )
}

/* ---------------------------------------------------------------- roles of one account */

export function RoleActions({ userId, assignments, sites, buildings, needsPassword = false }: {
  userId: string; assignments: { id: string; label: string }[]; sites: SiteOpt[]; buildings: BuildingOpt[]; needsPassword?: boolean
}) {
  const router = useRouter()
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [spec, setSpec] = useState<RoleSpecValue>(initialSpec())
  const [reason, setReason] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<ApiFail>()
  const [removing, setRemoving] = useState<{ id: string; label: string }>()

  async function submit() {
    setBusy(true); setErr(undefined)
    const r = await post<{ warnings: string[] }>(`/api/v1/access/users/${userId}/role-changes`, { kind: 'add', reason: reason.trim(), ...specBody(spec), ...(needsPassword ? { confirmPassword: password } : {}) })
    setBusy(false)
    if (!r.ok) return setErr(r)
    setOpen(false); setReason(''); setPassword('')
    toast(`Sent for approval. ${r.data.warnings.join(' ')}`.trim())
    router.refresh()
  }
  return (
    <>
      <div className="row wrap">
        <Button variant="primary" icon="plus" onClick={() => setOpen(true)}>Request a role</Button>
        {assignments.map(a => <Button key={a.id} size="sm" variant="ghost" icon="ban" onClick={() => setRemoving(a)} aria-label={`Request removal of ${a.label}`}>Remove {a.label}</Button>)}
      </div>
      {open && (
        <Modal open onClose={() => setOpen(false)} title="Request a role" subtitle="A different Super Admin must approve it before anything changes"
          footer={<><Button onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" onClick={submit} disabled={busy || !reason.trim() || (needsPassword && !password)}>{busy ? 'Sending…' : 'Send for approval'}</Button></>}>
          {err && <Problem f={err} />}
          <RoleSpecFields value={spec} onChange={setSpec} sites={sites} buildings={buildings} errors={err?.fields} />
          <Field label="Reason (required)" error={err?.fields?.reason}><Textarea value={reason} onChange={e => setReason(e.target.value)} rows={3} /></Field>
          {needsPassword && <ConfirmPassword value={password} onChange={setPassword} error={err?.fields?.confirmPassword} />}
        </Modal>
      )}
      {removing && (
        <ReasonModal title={`Request removal of ${removing.label}`} subtitle="A different Super Admin must approve it. They are signed out when it is applied." confirm="Send for approval" danger needsPassword={needsPassword} onClose={() => setRemoving(undefined)}
          run={async (reason, confirmPassword) => {
            const r = await post(`/api/v1/access/users/${userId}/role-changes`, { kind: 'remove', assignmentId: removing.id, reason, ...(confirmPassword ? { confirmPassword } : {}) })
            if (r.ok) { setRemoving(undefined); toast('Sent for approval'); router.refresh() }
            return r
          }} />
      )}
    </>
  )
}

/* ---------------------------------------------------------------- capability grants of one account */

export function GrantActions({ userId, revocable, needsPassword = false }: { userId: string; revocable: { id: string; label: string; pending: boolean }[]; needsPassword?: boolean }) {
  const router = useRouter()
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [capability, setCapability] = useState<Capability>('BackupApprover')
  const [reason, setReason] = useState('')
  const [startsAt, setStartsAt] = useState('')
  const [expiresAt, setExpiresAt] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<ApiFail>()
  const [revoking, setRevoking] = useState<{ id: string; label: string; pending: boolean }>()
  const iso = (v: string) => (v ? new Date(v).toISOString() : undefined)

  async function submit() {
    setBusy(true); setErr(undefined)
    const r = await post<{ warnings: string[] }>('/api/v1/access/grants', { userId, capability, reason: reason.trim(), startsAt: iso(startsAt), expiresAt: iso(expiresAt), ...(needsPassword ? { confirmPassword: password } : {}) })
    setBusy(false)
    if (!r.ok) return setErr(r)
    setOpen(false); setReason(''); setStartsAt(''); setExpiresAt(''); setPassword('')
    toast(`Sent for approval. ${r.data.warnings.join(' ')}`.trim())
    router.refresh()
  }
  return (
    <>
      <div className="row wrap">
        <Button variant="primary" icon="plus" onClick={() => setOpen(true)}>Request a capability</Button>
        {revocable.map(g => <Button key={g.id} size="sm" variant="ghost" icon="ban" onClick={() => setRevoking(g)}>{g.pending ? 'Withdraw' : 'Revoke'} {g.label}</Button>)}
      </div>
      {open && (
        <Modal open onClose={() => setOpen(false)} title="Request a capability" subtitle="A different Super Admin must approve it before it takes effect"
          footer={<><Button onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" onClick={submit} disabled={busy || !reason.trim() || (needsPassword && !password)}>{busy ? 'Sending…' : 'Send for approval'}</Button></>}>
          {err && <Problem f={err} />}
          <Field label="Capability" error={err?.fields?.capability} hint={CAPABILITY_HINT[capability]}>
            <Select value={capability} onChange={e => setCapability(e.target.value as Capability)}>{CAPABILITIES.map(c => <option key={c} value={c}>{CAP_LABEL[c]}</option>)}</Select>
          </Field>
          <Alert tone="info" title="A capability adds actions, never sites" detail="Whatever it allows, the person acts only inside the sites their own role gives them (D-22)." />
          <Field label="Reason (required)" error={err?.fields?.reason}><Textarea value={reason} onChange={e => setReason(e.target.value)} rows={3} /></Field>
          <div className="grid even">
            <Field label="Starts" optional hint="Defaults to when it is approved" error={err?.fields?.startsAt}><Input type="datetime-local" value={startsAt} onChange={e => setStartsAt(e.target.value)} /></Field>
            <Field label="Expires" optional hint="Without one it stays until revoked" error={err?.fields?.expiresAt}><Input type="datetime-local" value={expiresAt} onChange={e => setExpiresAt(e.target.value)} /></Field>
          </div>
          {needsPassword && <ConfirmPassword value={password} onChange={setPassword} error={err?.fields?.confirmPassword} />}
        </Modal>
      )}
      {revoking && (
        <ReasonModal title={`${revoking.pending ? 'Withdraw' : 'Revoke'} ${revoking.label}`} subtitle={revoking.pending ? 'The request is withdrawn.' : 'It stops working on their next action.'} confirm={revoking.pending ? 'Withdraw' : 'Revoke'} danger needsPassword={needsPassword} onClose={() => setRevoking(undefined)}
          run={async (reason, confirmPassword) => {
            const r = await post(`/api/v1/access/grants/${revoking.id}/revoke`, { reason, ...(confirmPassword ? { confirmPassword } : {}) })
            if (r.ok) { setRevoking(undefined); toast(r.message ?? 'Done'); router.refresh() }
            return r
          }} />
      )}
    </>
  )
}

/* ---------------------------------------------------------------- the checker's buttons */

export function DecideButtons({ kind, id, canDecide, why, needsPassword = false }: { kind: 'role' | 'grant'; id: string; canDecide: boolean; why?: string; needsPassword?: boolean }) {
  const router = useRouter()
  const toast = useToast()
  const [mode, setMode] = useState<'approve' | 'reject'>()
  const url = kind === 'role' ? `/api/v1/access/role-changes/${id}/decide` : `/api/v1/access/grants/${id}/decide`
  if (!canDecide) return <span className="muted body-sm">{why}</span>
  return (
    <>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <Button size="sm" variant="primary" onClick={() => setMode('approve')}>Approve</Button>
        <Button size="sm" variant="danger" onClick={() => setMode('reject')}>Reject</Button>
      </div>
      {mode && (
        <ReasonModal title={mode === 'approve' ? 'Approve this change' : 'Reject this change'} subtitle={mode === 'approve' ? 'It takes effect now.' : 'Nothing will change. Say why.'}
          confirm={mode === 'approve' ? 'Approve' : 'Reject'} danger={mode === 'reject'} required={mode === 'reject'} label={mode === 'approve' ? 'Note' : 'Reason'} needsPassword={needsPassword} onClose={() => setMode(undefined)}
          run={async (note, confirmPassword) => {
            const r = await post(url, { decision: mode, note: note || undefined, ...(confirmPassword ? { confirmPassword } : {}) })
            if (r.ok) { setMode(undefined); toast(r.message ?? 'Done'); router.refresh() }
            return r
          }} />
      )}
    </>
  )
}
