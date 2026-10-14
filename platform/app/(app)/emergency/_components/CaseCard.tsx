/** One emergency check-in as a card: who, where, why, the deadline clock, who decides, and what you can do (or why you cannot). */
import Link from 'next/link'
import { Alert, Badge, Blocked, Countdown, GlassCard, Person } from '@/ui'
import type { CaseView } from '@/server/queries/emergency/cases'
import { CAP_LABEL, ROLE_LABEL } from '@/domain/labels'
import { DecideActions } from './DecideActions'

const utc = (iso: string) => iso.slice(0, 16).replace('T', ' ') + ' UTC'

export function StayChip({ status }: { status: string }) {
  if (status === 'provisional') return <Badge tone="info">Provisional</Badge>
  if (status === 'active') return <Badge tone="success">Active</Badge>
  if (status === 'resolution_pending') return <Badge tone="warning">Resolution pending</Badge>
  return <Badge tone="neutral">{status.replace(/_/g, ' ')}</Badge>
}

export function EscalationChip({ level, reminders }: { level: number; reminders: number }) {
  if (level >= 2) return <Badge tone="danger">Escalated: critical</Badge>
  if (level === 1) return <Badge tone="warning">Escalated to backup</Badge>
  if (reminders > 0) return <Badge tone="warning">{reminders === 1 ? '1 reminder sent' : `${reminders} reminders sent`}</Badge>
  return <Badge tone="neutral">Within deadline</Badge>
}

export function CaseCard({ c, detail, needsPassword = false }: { c: CaseView; detail?: boolean; needsPassword?: boolean }) {
  const pending = c.status === 'pending'
  const created = Date.parse(c.createdAt), deadline = Date.parse(c.deadlineAt)
  const viaLabel = c.decidedVia ? (c.decidedVia === 'AA' ? ROLE_LABEL.AA : CAP_LABEL[c.decidedVia]) : null
  return (
    <GlassCard strong>
      <div className="approval-card" style={{ padding: 0 }} data-testid="case-card" data-case={c.id} data-status={c.status}>
        <div className="row wrap" style={{ justifyContent: 'space-between' }}>
          <Person name={c.staffName} sub={`${c.employeeId} · ${c.bedCode} · ${c.roomName} · ${c.siteName}`} brand />
          <div className="row wrap">
            <StayChip status={c.stayStatus} />
            {pending ? <EscalationChip level={c.escalation} reminders={c.reminders} /> : <Badge tone={c.status === 'approved' ? 'success' : c.status === 'rejected' ? 'danger' : 'neutral'}>{c.status === 'converted' ? 'Closed: marked as Left' : c.status === 'approved' ? 'Approved' : 'Rejected'}</Badge>}
          </div>
        </div>

        <div>{c.reason}</div>

        {pending && (
          <div className="row wrap" style={{ gap: 16 }}>
            <Countdown to={deadline} from={created} label="decision deadline" />
            <span className="muted body-sm">
              Decides: <b>{c.currentOwner}</b> · started by {c.initiatedByName ?? 'a colleague'} ({ROLE_LABEL[c.initiatedByRole]})
            </span>
          </div>
        )}
        {pending && c.reminders > 0 && c.nextReminderAt && (
          <div className="muted body-sm">Last reminder {c.lastReminderAt ? utc(c.lastReminderAt) : 'sent'}. Next re-alert {utc(c.nextReminderAt)}. It stays Provisional until a person decides.</div>
        )}

        {pending && !c.eligibility.ok && <Alert tone="warning" title="Rules that would have failed at check-in" detail={c.eligibility.reasons.join('; ')} />}

        {pending && c.me.canDecide && <DecideActionsFor c={c} needsPassword={needsPassword} />}
        {pending && !c.me.canDecide && <Blocked why={c.me.why} owner={c.me.owner} next={c.me.next} />}

        {!pending && c.decidedAt && (
          <div className="muted body-sm">
            {c.status === 'converted' ? c.conversionNote : <>{c.status === 'approved' ? 'Approved' : 'Rejected'} by {c.decidedByName ?? 'an approver'}{viaLabel ? ` (${viaLabel})` : ''} on {utc(c.decidedAt)}{c.decisionNote ? `: ${c.decisionNote}` : ''}</>}
          </div>
        )}
        {c.status === 'rejected' && c.stayStatus === 'resolution_pending' && (
          <Blocked why="The resident is still in this bed" owner="Accommodation Admin" next="Relocate them or check them out on the stay, then close the relocation task. Nobody is moved automatically." />
        )}

        <div className="row wrap">
          <Link href={`/stays/${c.stayId}`} className="btn ghost sm">Open the stay</Link>
          {!detail && <Link href={`/emergency/${c.id}`} className="btn ghost sm">Case detail</Link>}
        </div>
      </div>
    </GlassCard>
  )
}

function DecideActionsFor({ c, needsPassword }: { c: CaseView; needsPassword: boolean }) {
  return <DecideActions caseId={c.id} who={c.staffName} bedCode={c.bedCode} failedReasons={c.eligibility.ok ? [] : c.eligibility.reasons} needsPassword={needsPassword} />
}
