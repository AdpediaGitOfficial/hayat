/**
 * The approvals inbox as the screen and the API show it: the framework's merged list (scope, SLA clock, "why you can't
 * approve") plus the delegation facts (D-32): who is out, and who is covering. Reading only. Delegation adds no authority:
 * "covering" is information on the card, not a right to decide.
 */
import { and, asc, eq, gte, isNull, lte } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { delegation, staffProfile, userAccount } from '@/server/db/schema'
import { loadAccess } from '@/server/auth/actor'
import { listInbox } from '@/server/approvals/inbox'
import type { InboxItem } from '@/server/approvals/types'
import type { Db } from '@/server/db/client'
import type { RequestContext } from '@/server/command/context'
import { approverScope, approvesAt, isApprover, type ApproverScope } from '@/server/commands/approvals/approvers'
import { getConfig } from '@/server/config/registry'
import { loadCalendar } from '@/server/eligibility'
import { nextMilestone } from '@/domain/requests'
import type { Calendar } from '@/domain/approvals'
import type { Actor } from '@/server/policy'

type Reader = Pick<Db, 'select'>
const fromUser = alias(userAccount, 'from_user')
const toUser = alias(userAccount, 'to_user')
const fromStaff = alias(staffProfile, 'from_staff')
const toStaff = alias(staffProfile, 'to_staff')

export interface DelegationView {
  id: string
  fromUserId: string
  fromName: string
  toUserId: string
  toName: string
  startsOn: string
  endsOn: string
  reason: string | null
  revoked: boolean
  /** Today is inside the range and it has not been revoked. */
  active: boolean
}

async function delegationRows(db: Reader, where: ReturnType<typeof and>, today: string): Promise<DelegationView[]> {
  const rows = await db.select({
    id: delegation.id, fromUserId: delegation.fromUserId, toUserId: delegation.toUserId, startsOn: delegation.startsOn, endsOn: delegation.endsOn, reason: delegation.reason,
    revokedAt: delegation.revokedAt, fromName: fromStaff.fullName, fromUsername: fromUser.username, toName: toStaff.fullName, toUsername: toUser.username,
  }).from(delegation)
    .innerJoin(fromUser, eq(fromUser.id, delegation.fromUserId)).leftJoin(fromStaff, eq(fromStaff.id, fromUser.staffId))
    .innerJoin(toUser, eq(toUser.id, delegation.toUserId)).leftJoin(toStaff, eq(toStaff.id, toUser.staffId))
    .where(where).orderBy(asc(delegation.startsOn), asc(delegation.createdAt)).limit(100)
  return rows.map(r => ({
    id: r.id, fromUserId: r.fromUserId, fromName: r.fromName ?? r.fromUsername, toUserId: r.toUserId, toName: r.toName ?? r.toUsername,
    startsOn: r.startsOn, endsOn: r.endsOn, reason: r.reason, revoked: r.revokedAt !== null,
    active: r.revokedAt === null && r.startsOn <= today && r.endsOn >= today,
  }))
}

const todayOf = (now: Date) => now.toISOString().slice(0, 10)

/** The viewer's own delegations: ones they set (out) and ones that name them (in), not yet over and not revoked. */
export async function myDelegations(db: Reader, userId: string, now: Date): Promise<{ out: DelegationView[]; in: DelegationView[] }> {
  const today = todayOf(now)
  const live = [isNull(delegation.revokedAt), gte(delegation.endsOn, today)]
  return {
    out: await delegationRows(db, and(eq(delegation.fromUserId, userId), ...live), today),
    in: await delegationRows(db, and(eq(delegation.toUserId, userId), ...live), today),
  }
}

/** Who is out today, for the approvers of the same sites. */
export async function whoIsOut(db: Reader, actor: Actor, now: Date): Promise<(DelegationView & { siteNames?: string[] })[]> {
  const today = todayOf(now)
  const all = await delegationRows(db, and(isNull(delegation.revokedAt), lte(delegation.startsOn, today), gte(delegation.endsOn, today)), today)
  const out: DelegationView[] = []
  for (const d of all) {
    if (actor.sites === 'all') { out.push(d); continue }
    const s = approverScope(await loadAccess(db, d.fromUserId, now))
    if (isApprover(s) && [...s.byAction.values()].some(x => x.all || [...x.siteIds].some(id => (actor.sites as readonly string[]).includes(id)))) out.push(d)
  }
  return out
}

export interface InboxCard extends InboxItem {
  /** Delegations that name the viewer and cover this item's site: "acting for X until D". */
  coveringFor: { name: string; until: string }[]
  /** Approvers of this site who are out today, and who stands in for them. */
  awayNow: { name: string; standIn: string; until: string }[]
  /** The next step of the clock (reminder, backup, escalation) and when it falls due. Informational: it only reminds and escalates. */
  next?: { label: string; at: number }
}

export async function approvalsInbox(db: Reader, rc: Pick<RequestContext, 'actor' | 'user' | 'clock'>): Promise<InboxCard[]> {
  const now = rc.clock.now()
  const items = await listInbox(db, rc.actor, now)
  if (items.length === 0) return []
  const today = todayOf(now)
  const active = await delegationRows(db, and(isNull(delegation.revokedAt), lte(delegation.startsOn, today), gte(delegation.endsOn, today)), today)
  const scopes = new Map<string, ApproverScope>()
  for (const d of active) if (!scopes.has(d.fromUserId)) scopes.set(d.fromUserId, approverScope(await loadAccess(db, d.fromUserId, now)))
  const sla = await getConfig(db, 'timers.routine_sla_business_days')
  const cals = new Map<string, Calendar>()
  for (const i of items) if (!cals.has(i.siteId)) cals.set(i.siteId, await loadCalendar(db, i.siteId))
  return items.map(i => ({
    ...i,
    next: nextMilestone(i.createdAt, now.getTime(), sla, cals.get(i.siteId)!),
    coveringFor: active.filter(d => d.toUserId === rc.user.id && approvesAt(scopes.get(d.fromUserId)!, i.siteId)).map(d => ({ name: d.fromName, until: d.endsOn })),
    awayNow: active.filter(d => approvesAt(scopes.get(d.fromUserId)!, i.siteId)).map(d => ({ name: d.fromName, standIn: d.toName, until: d.endsOn })),
  }))
}
