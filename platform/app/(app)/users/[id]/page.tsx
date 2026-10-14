import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requirePage } from '@/server/auth/page'
import { getUserDetail } from '@/server/queries/access/users'
import { selectableBuildings, selectableSites } from '@/server/queries/access/sites'
import { pathId } from '@/server/queries/access/params'
import { CAP_LABEL, ROLE_LABEL } from '@/domain/labels'
import { SCOPE_LABEL } from '@/server/commands/access/rules'
import { Alert, Badge, Blocked, GlassCard, PageHeader } from '@/ui'
import { AccountActions, GrantActions, RoleActions } from '../components'
import { accountBadge, fmtUtc, grantBadge, requestBadge } from '../badges'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Account · Grand Hyatt Staff Accommodation' }

export default async function UserDetailPage({ params }: { params: { id: string } }) {
  const cur = await requirePage('users_roles.view')
  const id = pathId(params)
  const u = id ? await getUserDetail(cur.rc.actor, id, cur.rc.clock.now(), cur.rc.user.id) : undefined
  if (!u) notFound()
  const [sites, buildings] = u.canManageRoles
    ? await Promise.all([selectableSites(cur.rc.actor, 'users_roles.manage_roles_and_scope'), selectableBuildings(cur.rc.actor, 'users_roles.manage_roles_and_scope')])
    : [[], []]
  const roleLabel = (r: (typeof u.roles)[number]) => `${ROLE_LABEL[r.role]}${r.siteCode ? ` · ${r.siteCode}` : r.scopeKind === 'all' ? ' · all sites' : ''}`
  const active = u.status !== 'revoked'

  return (
    <>
      <PageHeader crumbs={['People', 'Users and access']} title={u.fullName ?? u.username}
        summary={<span className="row wrap"><span className="mono">{u.username}</span>{accountBadge(u)}{u.self && <Badge outline>This is you</Badge>}</span>}
        actions={<Link className="btn secondary" href="/users">All accounts</Link>} />

      <div className="grid two">
        <div className="stack">
          <GlassCard title="Account" subtitle="Sign-in, password and sessions" actions={<AccountActions userId={u.id} username={u.username} status={u.status} manageable={u.manageable} />}>
            <dl className="kv">
              <dt>Username</dt><dd className="mono">{u.username}</dd>
              <dt>Employee ID</dt><dd className="mono">{u.employeeId ?? 'No staff record'}</dd>
              <dt>Employment</dt><dd>{u.employmentStatus === 'left' ? <Badge tone="neutral">Left</Badge> : u.employmentStatus === 'active' ? 'Active' : '—'}</dd>
              <dt>Status</dt><dd>{accountBadge(u)}</dd>
              <dt>Last sign-in</dt><dd className="tnum">{fmtUtc(u.lastLoginAt)}</dd>
              <dt>Created</dt><dd className="tnum">{fmtUtc(u.createdAt)}</dd>
              <dt>Sites</dt><dd>{u.sites.length ? u.sites.map(s => `${s.code} · ${s.name}`).join(', ') : 'None'}</dd>
              <dt>Live sessions</dt><dd data-testid="live-sessions">{u.liveSessionCount}</dd>
              {u.lockedUntil && <><dt>Locked until</dt><dd className="tnum">{fmtUtc(u.lockedUntil)}</dd></>}
            </dl>
            {!u.manageable && u.notManageableReason && <div style={{ marginTop: 14 }}><Blocked why={u.notManageableReason} owner={u.self ? 'A different administrator' : 'Super Admin'} next={u.self ? 'Ask another Super Admin or Accommodation Admin' : 'Ask a Super Admin'} /></div>}
            {u.liveSessions.length > 0 && (
              <div className="tbl-wrap" style={{ marginTop: 14 }}>
                <table className="tbl"><thead><tr><th>Signed in</th><th>Last seen</th><th>Acting as</th><th>From</th></tr></thead>
                  <tbody>{u.liveSessions.map(s => (
                    <tr key={s.id}><td className="tnum">{fmtUtc(s.createdAt)}</td><td className="tnum">{fmtUtc(s.lastSeenAt)}</td><td>{s.activeRole ? ROLE_LABEL[s.activeRole] : '—'}</td><td className="muted">{s.ip ?? '—'}</td></tr>
                  ))}</tbody></table>
              </div>
            )}
          </GlassCard>

          <GlassCard title="Roles and scope" subtitle="Only a Super Admin changes these, and only with a second Super Admin's approval"
            actions={u.canManageRoles && active ? <RoleActions userId={u.id} sites={sites} buildings={buildings} assignments={u.roles.map(r => ({ id: r.id, label: roleLabel(r) }))} /> : undefined}>
            {u.roles.length === 0 ? <div className="tbl-empty">No role yet: this person cannot sign in until one is assigned.</div> : (
              <div className="tbl-wrap"><table className="tbl"><thead><tr><th>Role</th><th>Scope</th></tr></thead>
                <tbody>{u.roles.map(r => <tr key={r.id}><td>{ROLE_LABEL[r.role]}</td><td className="muted">{r.siteCode ? `${r.siteCode} · ${r.siteName}` : SCOPE_LABEL[r.scopeKind]}</td></tr>)}</tbody></table></div>
            )}
            {!u.canManageRoles && <div style={{ marginTop: 14 }}><Blocked why="Roles and scope can only be changed by a Super Admin" owner="Super Admin" next="Ask a Super Admin to file the change" /></div>}
            {u.roleChanges.length > 0 && (
              <>
                <div className="eyebrow" style={{ margin: '18px 0 8px' }}>Role changes</div>
                <div className="tbl-wrap"><table className="tbl stack-m"><thead><tr><th>Change</th><th>Filed by</th><th>Decided by</th><th>Status</th></tr></thead>
                  <tbody>{u.roleChanges.map(c => (
                    <tr key={c.id}>
                      <td data-h="Change"><b>{c.kind === 'add' ? 'Add' : 'Remove'} {ROLE_LABEL[c.role]}</b> <span className="muted">{c.siteCode ?? SCOPE_LABEL[c.scopeKind]}</span><div className="subtle body-sm">{c.reason}</div></td>
                      <td data-h="Filed by">{c.makerUsername ?? '—'}<div className="subtle body-sm tnum">{fmtUtc(c.createdAt)}</div></td>
                      <td data-h="Decided by">{c.checkerUsername ?? '—'}{c.decisionNote && <div className="subtle body-sm">{c.decisionNote}</div>}</td>
                      <td data-h="Status">{requestBadge(c.status)}</td>
                    </tr>
                  ))}</tbody></table></div>
              </>
            )}
          </GlassCard>

          <GlassCard title="Capabilities" subtitle="Extra actions on top of a role. They never add sites."
            actions={u.canManageRoles && active ? <GrantActions userId={u.id} revocable={u.grants.filter(g => ['pending', 'scheduled', 'active'].includes(g.state)).map(g => ({ id: g.id, label: CAP_LABEL[g.capability], pending: g.state === 'pending' }))} /> : undefined}>
            {u.grants.length === 0 ? <div className="tbl-empty">No capabilities.</div> : (
              <div className="tbl-wrap"><table className="tbl stack-m"><thead><tr><th>Capability</th><th>State</th><th>Dates</th><th>Filed / decided by</th></tr></thead>
                <tbody>{u.grants.map(g => (
                  <tr key={g.id}>
                    <td data-h="Capability"><b>{CAP_LABEL[g.capability]}</b><div className="subtle body-sm">{g.reason}</div></td>
                    <td data-h="State">{grantBadge(g.state)}</td>
                    <td data-h="Dates" className="tnum muted">From {fmtUtc(g.startsAt)}<br />{g.expiresAt ? `Until ${fmtUtc(g.expiresAt)}` : 'No end date'}</td>
                    <td data-h="By">{g.makerUsername ?? '—'} → {g.checkerUsername ?? 'waiting'}</td>
                  </tr>
                ))}</tbody></table></div>
            )}
          </GlassCard>
        </div>

        <div className="stack">
          <Alert tone="info" title="Maker-checker" detail="A role change or capability is filed by one Super Admin and takes effect only when a different one approves it. Nobody approves a change to their own access. The last active Super Admin can never be removed." />
          <Alert tone="info" title="Passwords are handed over, never emailed" detail="A reset or a new account shows a temporary password once, here. Only a hash is stored. The person must replace it at their next sign-in." />
        </div>
      </div>
    </>
  )
}
