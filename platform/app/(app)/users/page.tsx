import { requirePage } from '@/server/auth/page'
import { reauthEnabled } from '@/server/auth/reauth'
import { decide } from '@/server/policy'
import { listUsers, type UserListRow } from '@/server/queries/access/users'
import { listPendingApprovals } from '@/server/queries/access/approvals'
import { selectableBuildings, selectableSites } from '@/server/queries/access/sites'
import { toUserFilter, userListQuery } from '@/server/queries/access/params'
import { ROLES } from '@/domain/enums'
import { CAP_LABEL, ROLE_LABEL } from '@/domain/labels'
import { Alert, Badge, Blocked, GlassCard, PageHeader } from '@/ui'
import { NewAccountButton } from './components'
import { accountBadge, fmtUtc } from './badges'
import { LinkButton, RowLink } from './link-button'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Users & access · Grand Hyatt Staff Accommodation' }

const scopeText = (u: UserListRow) =>
  u.roles.some(r => r.scopeKind === 'all') ? 'All sites' : u.sites.length ? u.sites.map(s => s.code).join(', ') : 'Own record or jobs only'

export default async function UsersPage({ searchParams }: { searchParams: Record<string, string | string[] | undefined> }) {
  const cur = await requirePage('users_roles.view')
  const { actor } = cur.rc
  const flat = Object.fromEntries(Object.entries(searchParams).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v ?? '']))
  const parsed = userListQuery.safeParse(flat)
  const q = parsed.success ? parsed.data : {}
  const filter = toUserFilter(parsed.success ? parsed.data : userListQuery.parse({}))
  const { rows, hasMore } = await listUsers(actor, filter, cur.rc.clock.now(), cur.rc.user.id)

  const mayCreate = decide(actor, 'users_roles.manage_staff_accounts').allowed
  const maySeeApprovals = decide(actor, 'users_roles.approve_grant').allowed
  const [sites, buildings, pending] = await Promise.all([
    mayCreate ? selectableSites(actor, 'users_roles.manage_staff_accounts') : [],
    mayCreate && decide(actor, 'users_roles.manage_roles_and_scope').allowed ? selectableBuildings(actor, 'users_roles.manage_roles_and_scope') : [],
    maySeeApprovals ? listPendingApprovals(actor, cur.rc.user.id) : { roleChanges: [], grants: [] },
  ])
  const waiting = pending.roleChanges.length + pending.grants.length
  const page = parsed.success && parsed.data.page ? parsed.data.page : 1
  const qs = (p: number) => new URLSearchParams({ ...Object.fromEntries(Object.entries(flat).filter(([k, v]) => v && k !== 'page')), page: String(p) }).toString()

  return (
    <>
      <PageHeader crumbs={['People']} title="Users and access"
        summary="Accounts are created by an administrator and handed over with a temporary password. Roles and capabilities need a second Super Admin; capabilities add actions, never sites."
        actions={<>
          {maySeeApprovals && <LinkButton href="/users/approvals">Approvals{waiting > 0 ? ` (${waiting})` : ''}</LinkButton>}
          {mayCreate && <NewAccountButton sites={sites} buildings={buildings} canRequestRole={decide(actor, 'users_roles.manage_roles_and_scope').allowed} siteRequired={actor.sites !== 'all'} needsRolePassword={await reauthEnabled('access.role_change')} />}
        </>} />

      {actor.sites !== 'all' && <Alert tone="info" title="You see accounts in your own sites" detail="Administrator accounts and accounts that also belong to other sites can only be changed by a Super Admin." />}
      {!parsed.success && <Alert tone="warning" title="Some filters were not understood" detail="Showing everything you may see instead." />}

      <GlassCard strong flush>
        <form method="get" className="tbl-tool" style={{ paddingTop: 16 }}>
          <input className="input" name="q" defaultValue={q.q ?? ''} placeholder="Search name, username or employee ID" aria-label="Search" style={{ maxWidth: 320 }} />
          <select className="select" name="status" defaultValue={q.status ?? ''} aria-label="Status" style={{ maxWidth: 180 }}>
            <option value="">Any status</option><option value="active">Active</option><option value="invited">Invited</option><option value="revoked">Deactivated</option>
          </select>
          <select className="select" name="role" defaultValue={q.role ?? ''} aria-label="Role" style={{ maxWidth: 220 }}>
            <option value="">Any role</option>{ROLES.map(r => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
          </select>
          <button className="btn secondary" type="submit">Filter</button>
        </form>
        <div className="tbl-wrap">
          <table className="tbl stack-m">
            <thead><tr><th>Person</th><th>Roles and capabilities</th><th>Sites</th><th>Account</th><th>Last sign-in</th></tr></thead>
            <tbody>
              {rows.map(u => (
                <tr key={u.id}>
                  <td data-h="Person"><RowLink href={`/users/${u.id}`}><b>{u.fullName ?? u.username}</b></RowLink><div className="subtle body-sm">{u.username}{u.employeeId && u.employeeId !== u.username ? ` · ${u.employeeId}` : ''}{u.self ? ' · you' : ''}</div></td>
                  <td data-h="Roles"><span className="chips">
                    {u.roles.length === 0 && <span className="subtle">No role</span>}
                    {[...new Set(u.roles.map(r => r.role))].map(r => <Badge key={r} outline>{ROLE_LABEL[r]}</Badge>)}
                    {u.capabilities.map(c => <Badge key={c} tone="champagne" dot={false}>{CAP_LABEL[c]}</Badge>)}
                  </span></td>
                  <td data-h="Sites" className="muted">{scopeText(u)}</td>
                  <td data-h="Account">{accountBadge(u)}</td>
                  <td data-h="Last sign-in" className="muted tnum">{fmtUtc(u.lastLoginAt)}</td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={5}><div className="tbl-empty">No accounts match.{mayCreate ? ' Create one with New account.' : ''}</div></td></tr>}
            </tbody>
          </table>
        </div>
        <div className="card-foot"><span>{rows.length} {rows.length === 1 ? 'account' : 'accounts'} on this page</span>
          <span className="row">
            {page > 1 && <LinkButton variant="ghost" size="sm" href={`/users?${qs(page - 1)}`}>Previous</LinkButton>}
            {hasMore && <LinkButton variant="ghost" size="sm" href={`/users?${qs(page + 1)}`}>Next</LinkButton>}
          </span>
        </div>
      </GlassCard>
      {!mayCreate && <Blocked why="You can read accounts but not change them" owner="Super Admin or Accommodation Admin" next="Ask them to make the change" />}
    </>
  )
}
