import { useState } from 'react'
import { useAct, useCtx } from '../ctx'
import { A } from '../domain/store'
import { Alert, Badge, Blocked, Button, DataTable, Field, GlassCard, Input, Modal, PageHeader, Person, Select, StatTile, Status, Tabs, Textarea } from '../ui'
import { actingAs, can, hasRole } from '../domain/rules'
import { addDays, fmtDate, fmtDateTime, today } from '../domain/time'
import { CAP_LABEL, PERSONAS, ROLE_LABEL } from '../roles'
import type { Cap, Role } from '../domain/types'

/* ============ Users and access: accounts, capability grants, maker-checker (P-9) ============ */
export function Users() {
  const { s, persona, now } = useCtx()
  const act = useAct()
  const [tab, setTab] = useState<'users' | 'changes'>('users')
  const [req, setReq] = useState(false)
  const [reason, setReason] = useState<{ id: string; active: boolean } | null>(null)
  const isSA = hasRole(persona, 'SA')
  return (
    <>
      <PageHeader crumbs={['People']} title="Users and access" summary="Role, scope and capability changes need a second Super Admin. Grants add actions, never sites. Passwords are reset by an admin, never by email." 
        actions={<>{isSA && <Button variant="primary" icon="plus" onClick={() => setReq(true)}>Request access change</Button>}<Tabs value={tab} onChange={setTab} options={[{ id: 'users', label: 'Users' }, { id: 'changes', label: 'Changes', count: s.changes.filter(c => c.status === 'Pending').length }]} /></>} />
      {tab === 'users' && <DataTable rowKey={p => p.id} rows={PERSONAS} cols={[
        { key: 'n', header: 'User', render: p => <Person name={p.name} sub={p.title} /> },
        { key: 'r', header: 'Role and capabilities', render: p => { const e = actingAs(s, p, now); return <div className="chips"><Badge outline>{ROLE_LABEL[e.role]}</Badge>{e.caps.map(c => <Badge key={c} tone="champagne" dot={false}>{CAP_LABEL[c]}</Badge>)}</div> } },
        { key: 's', header: 'Scope', render: p => { const e = actingAs(s, p, now); return <span className="muted">{p.role === 'Res' && !e.caps.includes('Housekeeping') ? 'Own record' : e.sites === 'all' ? 'All sites' : e.sites.join(', ')}</span> } },
        { key: 'a', header: 'Account', render: p => { const e = actingAs(s, p, now); const a = s.accounts[p.id]; return e.revoked ? <Badge tone="danger">Login revoked</Badge> : a?.mustChange ? <Badge tone="warning">Must change password</Badge> : <Status s="Active" /> } },
        { key: 'x', header: '', align: 'r', render: p => { const admin = p.role !== 'Res'; const allowed = can(persona, admin ? 'account.reset.admin' : 'account.reset.staff'); const revoked = actingAs(s, p, now).revoked; return allowed ? <div className="row" style={{ justifyContent: 'flex-end' }}>
          <Button size="sm" onClick={() => act(A.resetPassword(persona, p.id))}>Reset password</Button>
          <Button size="sm" variant={revoked ? 'secondary' : 'danger'} onClick={() => setReason({ id: p.id, active: !!revoked })}>{revoked ? 'Reactivate' : 'Deactivate'}</Button></div> : null } },
      ]} />}
      {tab === 'changes' && <DataTable rowKey={c => c.id} rows={[...s.changes].reverse()} empty="No access changes yet" cols={[
        { key: 'k', header: 'Change', render: c => <Person name={`${PERSONAS.find(p => p.id === c.targetPersonaId)?.name}: ${c.kind} ${c.cap ? CAP_LABEL[c.cap] : c.role ? ROLE_LABEL[c.role] : Array.isArray(c.sites) ? c.sites.join(', ') : 'all sites'}`} sub={`${c.reason}${c.expires ? ` · until ${fmtDate(c.expires)}` : ''}`} /> },
        { key: 'r', header: 'Requested by', render: c => <span>{c.requestedBy}<div className="subtle body-sm">{fmtDateTime(c.at)}</div></span> },
        { key: 's', header: 'Status', render: c => <Badge tone={c.status === 'Applied' ? 'success' : c.status === 'Rejected' ? 'danger' : 'brand'}>{c.status}{c.decidedBy ? ` · ${c.decidedBy}` : ''}</Badge> },
        { key: 'x', header: '', align: 'r', render: c => c.status === 'Pending' && isSA ? <div className="row" style={{ justifyContent: 'flex-end' }}><Button size="sm" variant="primary" onClick={() => act(A.decidePermissionChange(persona, c.id, true, ''))}>Approve</Button><Button size="sm" variant="danger" onClick={() => act(A.decidePermissionChange(persona, c.id, false, 'Not needed'))}>Reject</Button></div> : null },
      ]} />}
      <Alert tone="info" title="Maker-checker" detail="With only two Super Admins, a change to either of them cannot be approved by anyone else. It stays pending rather than bypassing the control. Name a third governance approver (GH-01)." />
      {req && <ChangeModal onClose={() => setReq(false)} />}
      {reason && <ReasonModal id={reason.id} activate={reason.active} onClose={() => setReason(null)} />}
    </>
  )
}
function ChangeModal({ onClose }: { onClose: () => void }) {
  const { persona } = useCtx()
  const act = useAct()
  const [kind, setKind] = useState<'grant' | 'revoke' | 'role' | 'scope'>('grant')
  const [target, setTarget] = useState('p-mgr')
  const [cap, setCap] = useState<Cap>('ReportExport')
  const [role, setRole] = useState<Role>('AA')
  const [sites, setSites] = useState('PV,MA')
  const [reason, setReason] = useState('')
  const [expires, setExpires] = useState(addDays(today(), 14))
  const submit = () => act(A.requestPermissionChange(persona, { kind, targetPersonaId: target, cap, role, sites: sites === 'all' ? 'all' : sites.split(',').map(x => x.trim()).filter(Boolean), reason, expires: kind === 'grant' ? expires : undefined }), onClose)
  return (
    <Modal open onClose={onClose} title="Request an access change" subtitle="A different Super Admin must approve before it takes effect"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={submit}>Send for approval</Button></>}>
      <Field label="Change"><Select value={kind} onChange={e => setKind(e.target.value as 'grant')}><option value="grant">Grant a capability</option><option value="revoke">Revoke a capability</option><option value="role">Change role</option><option value="scope">Change site scope</option></Select></Field>
      <Field label="User"><Select value={target} onChange={e => setTarget(e.target.value)}>{PERSONAS.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field>
      {(kind === 'grant' || kind === 'revoke') && <Field label="Capability"><Select value={cap} onChange={e => setCap(e.target.value as Cap)}>{Object.entries(CAP_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>}
      {kind === 'role' && <Field label="New role"><Select value={role} onChange={e => setRole(e.target.value as Role)}>{Object.entries(ROLE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>}
      {kind === 'scope' && <Field label="Sites" hint="Comma separated site codes, or “all”. Only a Super Admin can change scope."><Input value={sites} onChange={e => setSites(e.target.value)} /></Field>}
      {kind === 'grant' && <Field label="Expires" hint="Time-limited grants end by themselves" optional><Input type="date" value={expires} onChange={e => setExpires(e.target.value)} /></Field>}
      <Field label="Reason (required)"><Textarea value={reason} onChange={e => setReason(e.target.value)} /></Field>
    </Modal>
  )
}
function ReasonModal({ id, activate, onClose }: { id: string; activate: boolean; onClose: () => void }) {
  const { persona } = useCtx()
  const act = useAct()
  const [r, setR] = useState('')
  return (
    <Modal open onClose={onClose} title={activate ? 'Reactivate this account' : 'Deactivate this account'} subtitle={activate ? undefined : 'The login is revoked immediately'}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant={activate ? 'primary' : 'danger'} onClick={() => act(A.setAccountActive(persona, id, activate, r), onClose)}>{activate ? 'Reactivate' : 'Deactivate'}</Button></>}>
      <Field label="Reason"><Textarea value={r} onChange={e => setR(e.target.value)} /></Field>
    </Modal>
  )
}

/* ============ Notification log: delivery status, retries, failures (P-3) ============ */
export function NotificationLog() {
  const { s, persona } = useCtx()
  const act = useAct()
  const [f, setF] = useState<'attention' | 'all'>('attention')
  const email = s.notifications.filter(n => n.email)
  const count = (st: string) => email.filter(n => n.emailStatus === st).length
  const rows = (f === 'attention' ? email.filter(n => n.emailStatus === 'failed' || n.emailStatus === 'retrying' || n.emailStatus === 'queued') : email).slice(0, 60)
  return (
    <>
      <PageHeader crumbs={['Insight']} title="Notification log" summary="In-app is immediate. Email is queued, retried with backoff, and only “delivered” when the provider confirms. A failure never changes a business decision."
        actions={<Tabs value={f} onChange={setF} options={[{ id: 'attention', label: 'Needs attention', count: count('failed') + count('retrying') + count('queued') }, { id: 'all', label: 'All email', count: email.length }]} />} />
      <div className="grid stats">
        <StatTile label="Queued / retrying" value={count('queued') + count('retrying')} icon="clock" goodUp={false} />
        <StatTile label="Sent, awaiting receipt" value={count('sent')} icon="send" />
        <StatTile label="Delivered" value={count('delivered')} icon="checkCircle" />
        <StatTile label="Failed" value={count('failed')} icon="alert" goodUp={false} hint={`${email.filter(n => n.emailStatus === 'failed' && n.critical).length} critical`} />
      </div>
      <GlassCard strong title="Email provider" subtitle="Demo control: simulate an outage to watch retries, then visible failure" actions={<Button variant={s.emailProviderUp ? 'danger' : 'primary'} onClick={() => act(A.setEmailProvider(!s.emailProviderUp))}>{s.emailProviderUp ? 'Simulate outage' : 'Restore provider'}</Button>}>
        <div className="row"><Badge tone={s.emailProviderUp ? 'success' : 'danger'}>{s.emailProviderUp ? 'Provider reachable' : 'Provider unreachable'}</Badge><span className="muted body-sm">Retries after {s.config.emailBackoffMinutes.join(', ')} minutes, then fails visibly. Critical alerts that fail are raised to admins.</span></div>
      </GlassCard>
      <DataTable rowKey={n => n.id} rows={rows} empty="Nothing needs attention" cols={[
        { key: 't', header: 'Message', render: n => <div style={{ maxWidth: 420 }}><b style={{ fontWeight: 500 }}>{n.text.slice(0, 110)}</b><div className="subtle body-sm">to {n.toStaffId ?? n.toRole} · {fmtDateTime(n.at)}</div></div> },
        { key: 'c', header: 'Kind', render: n => n.critical ? <Badge tone="danger">Critical</Badge> : <Badge outline>Standard</Badge> },
        { key: 's', header: 'Email status', render: n => <Badge tone={n.emailStatus === 'delivered' ? 'success' : n.emailStatus === 'failed' ? 'danger' : n.emailStatus === 'sent' ? 'info' : 'warning'}>{n.emailStatus}</Badge> },
        { key: 'a', header: 'Attempts', render: n => <span className="tnum">{n.attempts ?? 0}{n.lastError ? ` · ${n.lastError}` : ''}</span> },
        { key: 'x', header: '', align: 'r', render: n => n.emailStatus === 'failed' && can(persona, 'notification.retry') ? <Button size="sm" onClick={() => act(A.retryNotification(persona, n.id))}>Retry</Button> : null },
      ]} />
      {persona.role !== 'SA' && persona.role !== 'AA' && <Blocked why="Only admins can retry" owner="Accommodation Admin" />}
    </>
  )
}
