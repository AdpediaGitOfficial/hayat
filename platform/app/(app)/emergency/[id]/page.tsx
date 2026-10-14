import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requirePage } from '@/server/auth/page'
import { getDb } from '@/server/db/client'
import { getCase } from '@/server/queries/emergency/cases'
import { listTasks } from '@/server/queries/emergency/tasks'
import { mayUseEmergency, primaryLabel, reminderDueAt, LEVEL_LABEL } from '@/server/commands/emergency/rules'
import { Badge, Blocked, Countdown, GlassCard, PageHeader } from '@/ui'
import { CaseCard } from '../_components/CaseCard'
import { CompleteTask } from '../_components/CompleteTask'
import { can } from '@/server/policy'
import { isUuid } from '@/server/commands/emergency/shared'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Emergency check-in case · Grand Hyatt Staff Accommodation' }

const utc = (iso: string) => iso.slice(0, 16).replace('T', ' ') + ' UTC'

export default async function EmergencyCase({ params }: { params: { id: string } }) {
  const cur = await requirePage()
  const { actor, user } = cur.rc
  if (!mayUseEmergency(actor) || !isUuid(params.id)) notFound()
  const r = await getCase(getDb(), { actor, userId: user.id }, params.id)
  if (!r) notFound()
  const { item: c, timing } = r
  const tasks = (await listTasks(getDb(), actor, cur.rc.clock.now(), {})).filter(t => t.caseId === c.id)
  const deadline = Date.parse(c.deadlineAt)

  const steps = [
    { n: 0, title: `Decision deadline: ${utc(c.deadlineAt)}`, who: primaryLabel(c.approverRoute) },
    ...[1, 2].map(n => ({ n, title: n === 1 ? `Reminder 1 at the deadline, re-alert every ${timing.realertHours} h` : `Reminder ${timing.escalateAfter} unanswered: escalate`, who: LEVEL_LABEL[n] })),
  ]

  return (
    <>
      <PageHeader crumbs={['Accommodation', 'Emergency check-in']} title={`Emergency check-in: ${c.staffName}`}
        summary={`${c.employeeId} · ${c.bedCode} · ${c.siteName}`} actions={<Link href="/emergency" className="btn ghost">All emergency check-ins</Link>} />
      <div className="grid two">
        <div className="stack">
          <CaseCard c={c} detail />
          {tasks.map(t => (
            <GlassCard key={t.id} title="Relocation or checkout task" subtitle={t.doneAt ? 'Done' : 'Open'} strong>
              <div className="stack" style={{ gap: 8 }}>
                <b>{t.title}</b>
                {t.detail && <p className="muted body-sm" style={{ margin: 0 }}>{t.detail}</p>}
                {!t.doneAt && t.dueAt && <Countdown to={Date.parse(t.dueAt)} label="deadline" />}
                {t.doneAt && <div className="muted body-sm">Done {utc(t.doneAt)}{t.doneNote ? `: ${t.doneNote}` : ''}</div>}
                {!t.doneAt && t.stayStatus === 'resolution_pending' && <Blocked why="The resident is still in the bed" owner="Accommodation Admin" next="Transfer or check them out on the stay, then mark this task done" />}
                {!t.doneAt && can(actor, 'emergency_checkin.approve', { siteId: t.siteId }) && <div><CompleteTask taskId={t.id} title={t.title} /></div>}
              </div>
            </GlassCard>
          ))}
        </div>
        <div className="stack">
          <GlassCard title="Approver" strong>
            <div className="stack" style={{ gap: 10 }}>
              <div className="row wrap"><Badge tone="brand">Route: {primaryLabel(c.approverRoute)}</Badge>{c.escalation > 0 && <Badge tone={c.escalation > 1 ? 'danger' : 'warning'}>Now with: {c.currentOwner}</Badge>}</div>
              <p className="muted body-sm" style={{ margin: 0 }}>Started by {c.initiatedByName ?? 'a colleague'}. An {c.initiatedByRole === 'AA' ? 'Accommodation Admin' : 'initiator'} never approves their own check-in, so an {c.initiatedByRole === 'AA' ? 'Accommodation Admin start goes to a Policy Approver' : 'Reception start goes to an Accommodation Admin'} (D-68).</p>
              {c.status === 'pending' && !c.me.canDecide && <Blocked why={c.me.why} owner={c.me.owner} next={c.me.next} />}
            </div>
          </GlassCard>
          <GlassCard title="Clock" subtitle="Hours, day and night" strong>
            <ol className="list-plain" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              <li style={{ display: 'block' }}>Started {utc(c.createdAt)}</li>
              <li style={{ display: 'block' }}>Deadline {utc(c.deadlineAt)}{c.status === 'pending' && <> · <Countdown to={deadline} /></>}</li>
              <li style={{ display: 'block' }}>Reminders sent: {c.reminders}{c.lastReminderAt ? ` (last ${utc(c.lastReminderAt)})` : ''}</li>
              {c.status === 'pending' && c.nextReminderAt && <li style={{ display: 'block' }}>Next reminder {utc(new Date(reminderDueAt(deadline, c.reminders + 1, timing)).toISOString())}</li>}
              <li style={{ display: 'block' }}>Escalation: {c.escalation === 0 ? 'none yet' : `${c.escalation} (${LEVEL_LABEL[c.escalation]})`}{c.escalatedAt ? `, ${utc(c.escalatedAt)}` : ''}</li>
            </ol>
            <p className="muted body-sm" style={{ marginBottom: 0 }}>{steps.map(s => `${s.title} → ${s.who}`).join('. ')}.</p>
          </GlassCard>
        </div>
      </div>
    </>
  )
}
