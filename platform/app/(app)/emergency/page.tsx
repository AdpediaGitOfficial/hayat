import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requirePage } from '@/server/auth/page'
import { getDb } from '@/server/db/client'
import { can } from '@/server/policy'
import { listCases } from '@/server/queries/emergency/cases'
import { listTasks } from '@/server/queries/emergency/tasks'
import { mayUseEmergency, primaryLabel, routeFor } from '@/server/commands/emergency/rules'
import { Alert, Blocked, Countdown, GlassCard, PageHeader } from '@/ui'
import { CaseCard } from './_components/CaseCard'
import { CompleteTask } from './_components/CompleteTask'
import { InitiateForm } from './_components/InitiateForm'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Emergency check-in · Grand Hyatt Staff Accommodation' }

export default async function EmergencyPage() {
  const cur = await requirePage()
  const { actor, user } = cur.rc
  if (!mayUseEmergency(actor)) notFound()
  const now = cur.rc.clock.now()
  const db = getDb()
  const [{ items, timing }, tasks] = await Promise.all([
    listCases(db, { actor, userId: user.id }, { limit: 100 }),
    listTasks(db, actor, now, {}),
  ])
  const canInitiate = can(actor, 'emergency_checkin.initiate')
  const pending = items.filter(i => i.status === 'pending')
  const decided = items.filter(i => i.status !== 'pending').slice(0, 15)
  const openTasks = tasks.filter(t => !t.doneAt)

  return (
    <>
      <PageHeader eyebrow="Accommodation" title="Emergency check-in"
        summary={`A provisional stay now, a decision within ${timing.deadlineHours} hours. Re-alerts every ${timing.realertHours} hours and escalates after ${timing.escalateAfter} unanswered. Never approved, rejected, moved or checked out by a timer.`} />

      {canInitiate && (
        <div style={{ maxWidth: 640 }}>
          <InitiateForm approver={primaryLabel(routeFor(actor.role))} deadlineHours={timing.deadlineHours} />
        </div>
      )}

      <div className="grid two">
        <div className="stack">
          <GlassCard title="Waiting for a decision" subtitle={pending.length ? `${pending.length} open` : undefined} flush={pending.length === 0}>
            {pending.length === 0
              ? <div className="tbl-empty">No emergency check-ins are waiting for a decision.</div>
              : <div className="stack">{pending.map(c => <CaseCard key={c.id} c={c} />)}</div>}
          </GlassCard>

          <GlassCard title="Relocation and checkout tasks" subtitle="After a rejection. The resident is never moved automatically." strong flush={openTasks.length === 0}>
            {openTasks.length === 0
              ? <div className="tbl-empty">No open tasks.</div>
              : (
                <ul className="list-plain" data-testid="task-list">
                  {openTasks.map(t => (
                    <li key={t.id} style={{ display: 'block' }} data-task={t.id}>
                      <div className="row wrap" style={{ justifyContent: 'space-between' }}>
                        <b>{t.title}</b>
                        {t.dueAt && <Countdown to={Date.parse(t.dueAt)} label="deadline" />}
                      </div>
                      {t.detail && <p className="muted body-sm" style={{ margin: '4px 0 8px' }}>{t.detail}</p>}
                      <div className="row wrap">
                        <span className="muted body-sm">Owner: Accommodation Admin</span>
                        <span className="spacer" />
                        {t.stayId && <Link href={`/stays/${t.stayId}`} className="btn ghost sm">Open the stay</Link>}
                        {can(actor, 'emergency_checkin.approve', { siteId: t.siteId }) && <CompleteTask taskId={t.id} title={t.title} />}
                      </div>
                      {t.stayStatus === 'resolution_pending' && <Blocked why="The resident is still in the bed" owner="Accommodation Admin" next="Transfer or check them out on the stay, then mark this task done" />}
                    </li>
                  ))}
                </ul>
              )}
          </GlassCard>

          {decided.length > 0 && (
            <GlassCard title="Recently decided" strong flush>
              <ul className="list-plain" style={{ padding: '0 20px 8px' }}>
                {decided.map(c => (
                  <li key={c.id}>
                    <div style={{ flex: 1 }}>
                      <Link href={`/emergency/${c.id}`}><b>{c.staffName}</b></Link>
                      <div className="muted body-sm">{c.bedCode} · {c.siteName}{c.decisionNote ? ` · ${c.decisionNote}` : ''}</div>
                    </div>
                    <span className={`badge ${c.status === 'approved' ? 'success' : c.status === 'rejected' ? 'danger' : 'neutral'}`}>{c.status === 'converted' ? 'Closed: left' : c.status === 'approved' ? 'Approved' : 'Rejected'}</span>
                  </li>
                ))}
              </ul>
            </GlassCard>
          )}
        </div>

        <div className="stack">
          {!canInitiate && (
            <GlassCard title="Start an emergency check-in" strong>
              <Blocked why="Only holders of the Emergency Check-in capability can start one" owner="Super Admin (grants capabilities with a second Super Admin)" next="Ask a colleague who holds the capability, or request the grant" />
            </GlassCard>
          )}
          <Alert tone="info" title="How it works"
            detail="The person gets a bed at once as a provisional stay. An independent approver (never the one who started it) approves or rejects. A rejection needs a reason and opens a relocation task for an Accommodation Admin." />
        </div>
      </div>
    </>
  )
}
