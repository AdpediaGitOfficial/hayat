import { requirePage } from '@/server/auth/page'
import { getDb } from '@/server/db/client'
import { can } from '@/server/policy'
import { approvalsInbox, myDelegations, whoIsOut } from '@/server/queries/requests/inbox'
import { approverScope, isApprover } from '@/server/commands/approvals/approvers'
import { loadAccess } from '@/server/auth/actor'
import { Badge, Blocked, Countdown, GlassCard, Icon, PageHeader } from '@/ui'
import { LinkButton, fmtStamp } from '../requests/_components/format'
import { DelegationPanel } from './_components/DelegationPanel'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Approvals · Grand Hyatt Staff Accommodation' }

const KIND: Record<string, { label: string; cta: string }> = {
  request: { label: 'Bed request', cta: 'Review and allocate' },
  exception: { label: 'Exception', cta: 'Review exception' },
  waitlist_priority: { label: 'Waitlist priority', cta: 'Review priority' },
  transfer: { label: 'Transfer (from this site)', cta: 'Review transfer' },
  transfer_in: { label: 'Transfer (into this site)', cta: 'Review transfer' },
  swap: { label: 'Bed swap (from this site)', cta: 'Review swap' },
  swap_in: { label: 'Bed swap (into this site)', cta: 'Review swap' },
  transfer_exception: { label: 'Transfer exception (proposed policy)', cta: 'Review exception' },
  transfer_exception_other: { label: 'Swap exception (proposed policy)', cta: 'Review exception' },
  extension: { label: 'Stay extension', cta: 'Review extension' },
  emergency: { label: 'Emergency check-in', cta: 'Review case' },
}

export default async function Approvals({ searchParams }: { searchParams: Record<string, string | string[] | undefined> }) {
  const cur = await requirePage('approvals_inbox.view')
  const db = getDb()
  const now = cur.rc.clock.now()
  const all = searchParams.show === 'all'
  const [cards, mine, out, access] = await Promise.all([
    approvalsInbox(db, cur.rc), myDelegations(db, cur.rc.user.id, now), whoIsOut(db, cur.rc.actor, now), loadAccess(db, cur.rc.user.id, now),
  ])
  const waiting = cards.filter(c => c.mine)
  const list = all ? cards : waiting
  const canDelegate = isApprover(approverScope(access, cur.rc.user.staffId)) && can(cur.rc.actor, 'approvals_inbox.view')
  const covering = mine.in.filter(d => d.active)

  return (
    <>
      <PageHeader eyebrow="Approvals" title="Approvals inbox" summary={`${waiting.length} waiting on you · one inbox for every route`}
        actions={<><LinkButton href="/approvals" variant={all ? 'secondary' : 'primary'}>Waiting on me ({waiting.length})</LinkButton><LinkButton href="/approvals?show=all" variant={all ? 'primary' : 'secondary'}>All routes ({cards.length})</LinkButton></>} />
      <div className="grid two" style={{ gridTemplateColumns: 'minmax(0,1fr) minmax(0,360px)' }}>
        <div className="stack">
          {list.length === 0 && <GlassCard><div className="tbl-empty"><Icon name="checkCircle" size={20} /><div>You&apos;re all caught up</div></div></GlassCard>}
          {list.map(i => {
            const tone = i.clock.level === 2 ? 'danger' : i.clock.level === 1 ? 'warning' : 'info'
            const k = KIND[i.kind] ?? { label: i.kind, cta: 'Open' }
            return (
              <GlassCard key={`${i.kind}:${i.ref}`} strong>
                <div className="approval-card" data-testid="approval-card">
                  <div className="row wrap">
                    <Badge tone="brand" dot={false}>{k.label}</Badge>
                    {i.urgent && <Badge tone="danger">Urgent</Badge>}
                    <Badge tone={tone}>{i.clock.label}</Badge>
                    <span className="spacer" />
                    <span className="subtle body-sm">Raised {fmtStamp(new Date(i.createdAt).toISOString())}</span>
                  </div>
                  <div><b style={{ fontSize: 15 }}>{i.title}</b><div className="muted">{i.sub}</div></div>
                  <div className="chips">
                    <Badge outline>Route: {i.primary} → {i.backup}</Badge>
                    <Badge outline>Now with: {i.current}</Badge>
                    <Badge outline>Reminders: {i.clock.reminders}</Badge>
                    <Badge outline>Escalation level {i.clock.level}</Badge>
                    {i.next && <Countdown to={i.next.at} label={i.next.label.toLowerCase()} warnBelowMs={6 * 3600_000} />}
                  </div>
                  {i.coveringFor.map((c, n) => <Badge key={n} tone="info" icon="user">Acting for {c.name} until {c.until}</Badge>)}
                  {i.awayNow.length > 0 && <div className="muted body-sm">Out of office: {i.awayNow.map(a => `${a.name} (back after ${a.until}; ${a.standIn} covers)`).join('; ')}</div>}
                  {!i.mine && i.why && <Blocked why={`Why you can't approve: ${i.why}`} owner={i.current} />}
                  <div className="row wrap"><LinkButton href={i.href} variant={i.mine ? 'primary' : 'secondary'}>{i.mine ? k.cta : 'Open'}</LinkButton></div>
                </div>
              </GlassCard>
            )
          })}
        </div>
        <div className="stack" style={{ alignSelf: 'start' }}>
          <DelegationPanel mine={mine.out} covering={covering} canDelegate={canDelegate} today={now.toISOString().slice(0, 10)} />
          {out.length > 0 && (
            <GlassCard title="Who is out today" subtitle="Approvers of your sites who are away, and who covers">
              <ul className="list-plain">{out.map(d => <li key={d.id}><span style={{ flex: 1 }}><b>{d.fromName}</b> <span className="muted body-sm">until {d.endsOn} · {d.toName} covers</span></span></li>)}</ul>
            </GlassCard>
          )}
          <GlassCard title="How timing works"><ul className="list-plain body-sm muted">
            <li>Reminder at 1 business day, routed to the backup at 2, escalated at 3.</li>
            <li>Emergency check-ins run on hours, not days.</li>
            <li><span><b>Nothing ever auto-approves, auto-rejects, moves or checks out a resident.</b> A timer only reminds and escalates.</span></li>
          </ul></GlassCard>
        </div>
      </div>
    </>
  )
}
