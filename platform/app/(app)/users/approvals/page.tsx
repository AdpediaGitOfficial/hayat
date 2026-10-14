import { requirePage } from '@/server/auth/page'
import { reauthEnabled } from '@/server/auth/reauth'
import { listPendingApprovals } from '@/server/queries/access/approvals'
import { CAP_LABEL, ROLE_LABEL } from '@/domain/labels'
import { SCOPE_LABEL } from '@/server/commands/access/rules'
import { Alert, Badge, GlassCard, PageHeader } from '@/ui'
import { DecideButtons } from '../components'
import { fmtUtc } from '../badges'
import { LinkButton, RowLink } from '../link-button'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Approvals · Grand Hyatt Staff Accommodation' }

export default async function ApprovalsPage() {
  const cur = await requirePage('users_roles.approve_grant')
  const { roleChanges, grants } = await listPendingApprovals(cur.rc.actor, cur.rc.user.id)
  const [needsRolePassword, needsGrantPassword] = await Promise.all([reauthEnabled('access.role_change'), reauthEnabled('access.grant')])
  const why = (x: { mine: boolean; aboutMe: boolean }) => x.mine ? 'You filed this, so a different Super Admin decides it' : 'It is about your own access, so a different Super Admin decides it'
  return (
    <>
      <PageHeader crumbs={['People', 'Users and access']} title="Approvals" summary="Role changes and capability grants waiting for a second Super Admin."
        actions={<LinkButton href="/users">All accounts</LinkButton>} />
      {roleChanges.length + grants.length === 0 && <Alert tone="success" title="Nothing is waiting" detail="Role changes and capability requests appear here as soon as a Super Admin files one." />}

      <GlassCard strong flush title="Role changes" subtitle="Applied the moment a different Super Admin approves; the person is signed out so the new access starts clean">
        <div className="tbl-wrap"><table className="tbl stack-m"><thead><tr><th>Person</th><th>Change</th><th>Filed by</th><th /></tr></thead>
          <tbody>
            {roleChanges.map(c => (
              <tr key={c.id} data-testid="pending-role-change">
                <td data-h="Person"><RowLink href={`/users/${c.targetUserId}`}><b>{c.targetName ?? c.targetUsername}</b></RowLink><div className="subtle body-sm">{c.targetUsername}</div></td>
                <td data-h="Change"><b>{c.kind === 'add' ? 'Add' : 'Remove'} {ROLE_LABEL[c.role]}</b> <span className="muted">{c.siteCode ?? SCOPE_LABEL[c.scopeKind]}</span><div className="subtle body-sm">{c.reason}</div></td>
                <td data-h="Filed by">{c.makerUsername ?? '—'}{c.mine && <> <Badge outline>you</Badge></>}<div className="subtle body-sm tnum">{fmtUtc(c.createdAt)}</div></td>
                <td data-h="" style={{ textAlign: 'right' }}><DecideButtons kind="role" id={c.id} canDecide={c.canDecide} why={why(c)} needsPassword={needsRolePassword} /></td>
              </tr>
            ))}
            {roleChanges.length === 0 && <tr><td colSpan={4}><div className="tbl-empty">No role changes waiting.</div></td></tr>}
          </tbody></table></div>
      </GlassCard>

      <GlassCard strong flush title="Capability grants" subtitle="A grant adds actions, never sites. It works only between its start and its end.">
        <div className="tbl-wrap"><table className="tbl stack-m"><thead><tr><th>Person</th><th>Capability</th><th>Dates</th><th>Filed by</th><th /></tr></thead>
          <tbody>
            {grants.map(g => (
              <tr key={g.id} data-testid="pending-grant">
                <td data-h="Person"><RowLink href={`/users/${g.targetUserId}`}><b>{g.targetName ?? g.targetUsername}</b></RowLink><div className="subtle body-sm">{g.targetUsername}</div></td>
                <td data-h="Capability"><b>{CAP_LABEL[g.capability]}</b><div className="subtle body-sm">{g.reason}</div></td>
                <td data-h="Dates" className="tnum muted" style={{ whiteSpace: 'nowrap' }}>From {fmtUtc(g.startsAt)}<br />{g.expiresAt ? `Until ${fmtUtc(g.expiresAt)}` : 'No end date'}</td>
                <td data-h="Filed by">{g.makerUsername ?? '—'}{g.mine && <> <Badge outline>you</Badge></>}<div className="subtle body-sm tnum">{fmtUtc(g.createdAt)}</div></td>
                <td data-h="" style={{ textAlign: 'right' }}><DecideButtons kind="grant" id={g.id} canDecide={g.canDecide} why={why(g)} needsPassword={needsGrantPassword} /></td>
              </tr>
            ))}
            {grants.length === 0 && <tr><td colSpan={5}><div className="tbl-empty">No capability requests waiting.</div></td></tr>}
          </tbody></table></div>
      </GlassCard>
    </>
  )
}
