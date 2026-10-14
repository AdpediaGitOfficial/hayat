/**
 * The approvals inbox: pending items from every registered source, scoped to what the viewer may decide at any
 * level, annotated with the SLA clock, the current owner, whether the viewer can decide now, and if not, why.
 * Reading the inbox never changes anything; the clock only describes (it never auto-decides).
 */
import { approvalClock, type ApprovalClock } from '@/domain/approvals'
import type { Db } from '@/server/db/client'
import { getConfig } from '@/server/config/registry'
import { loadCalendar } from '@/server/eligibility'
import { decide, type Actor } from '@/server/policy'
import { approvalSources } from './registry'
import './sources'
import type { ApprovalDraft, InboxItem } from './types'

type Reader = Pick<Db, 'select'>

export async function draftClock(db: Reader, d: ApprovalDraft, now: Date): Promise<ApprovalClock> {
  if (d.ownClock) return d.ownClock
  return approvalClock(d.createdAt, now.getTime(), await getConfig(db, 'timers.routine_sla_business_days'), await loadCalendar(db, d.siteId))
}

export async function pendingDrafts(db: Reader, now: Date): Promise<ApprovalDraft[]> {
  const all: ApprovalDraft[] = []
  for (const s of approvalSources()) all.push(...await s.listPending(db, now))
  return all
}

export async function listInbox(db: Reader, actor: Actor, now: Date, userId?: string): Promise<InboxItem[]> {
  const items: InboxItem[] = []
  for (const d of await pendingDrafts(db, now)) {
    const res = { siteId: d.siteId }
    if (!d.deciders.some(x => decide(actor, x.action, res).allowed)) continue // not in this person's scope at any level
    const clock = await draftClock(db, d, now)
    const own = actor.staffId !== undefined && (d.subjectStaffIds.includes(actor.staffId) || d.raisedByStaffId === actor.staffId)
    const reachable = d.deciders.filter(x => x.level <= clock.level)
    const allowedNow = reachable.some(x => decide(actor, x.action, res).allowed)
    const current = d.deciders.filter(x => x.level <= clock.level).sort((a, b) => b.level - a.level)[0] ?? d.deciders[0]
    const primary = d.deciders.find(x => x.level === 0)?.label ?? ''
    const backup = d.deciders.find(x => x.level === 1)?.label ?? ''
    // A source that knows its own rule says exactly who may decide (same function the command applies); otherwise the action at a reached level.
    const mine = !own && (d.decidable ? d.decidable(actor, { clock, userId }) : allowedNow)
    const why = mine ? undefined
      : own ? 'You cannot decide this: it is about you or raised by you (separation of duties, D-26). It is routed to an independent approver.'
        : d.whyNot?.(actor, { clock, userId }) ?? `Waiting for ${current.label}. Your role can decide it from the next level.`
    items.push({
      kind: d.kind, ref: d.ref, siteId: d.siteId, subjectStaffIds: d.subjectStaffIds, raisedByStaffId: d.raisedByStaffId,
      title: d.title, sub: d.sub, createdAt: d.createdAt, urgent: d.urgent, href: d.href,
      clock, current: current.label, primary, backup, mine, why,
    })
  }
  // Urgent first (D-46), then the most escalated, then the oldest.
  return items.sort((a, b) => Number(!!b.urgent) - Number(!!a.urgent) || b.clock.level - a.clock.level || a.createdAt - b.createdAt)
}
