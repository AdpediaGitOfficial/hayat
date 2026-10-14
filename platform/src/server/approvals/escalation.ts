/**
 * One rule for "may this person decide this pending item right now?", used by the commands, the queries behind the screens AND the
 * approvals inbox so they can never disagree (S-14, AT-033). Used for standard requests (and their bulk confirmation), transfers,
 * swaps and extensions.
 *
 *   - The primary decider (Accommodation Admin; for an extension beyond policy the Policy Approver) decides at any time, within
 *     their own scope. A Super Admin holds the primary action of requests, transfers and extensions, so the same applies.
 *   - A Policy Approver or Backup Approver (`approvals_inbox.decide_escalated`, site scope) decides only once the approval clock has
 *     reached the BACKUP level (APPROVALS.md: reminder at 1 business day, backup at 2, escalation at 3), and only when
 *     `approvals.escalation_backup` is on. PROPOSED, pending client sign-off (P-01): with the setting off only the primary decides.
 *   - Never the person the record is about nor the one who raised it (D-26): the caller checks that with `notSelf` / `notInvolved`;
 *     `mayDecideNow` includes it for the inbox.
 *   - Scope always comes from the actor's own sites: a grant at one site says nothing about another (out of scope reads as "not found").
 *
 * Nothing here decides for anyone: the clock only describes where the item is (timeouts never approve, reject, move or check out).
 */
import { approvalClock, type ApprovalClock, type ApprovalLevel } from '@/domain/approvals'
import type { Db } from '@/server/db/client'
import { fail, failure, type Failure } from '@/server/command/result'
import type { CommandContext } from '@/server/command/context'
import { getConfig } from '@/server/config/registry'
import { loadCalendar } from '@/server/eligibility'
import { decide, type Action, type Actor } from '@/server/policy'

/** The policy action that lets a Policy Approver or Backup Approver decide once the item has been routed past the primary (APPROVALS.md). */
export const BACKUP_ACTION: Action = 'approvals_inbox.decide_escalated'

type Reader = Pick<Db, 'select'>

export interface EscalationFacts {
  /** The primary decider's policy action (for example `requests_waitlist.approve`). */
  primary: Action
  siteId: string
  /** Where the approval clock stands (0 primary, 1 backup, 2 final). */
  level: ApprovalLevel
  /** `approvals.escalation_backup` (P-01, proposed, pending client sign-off). */
  backupOn: boolean
}

export type Standing =
  | { ok: true; via: 'primary' | 'backup' }
  | { ok: false; kind: 'out_of_scope' | 'no_grant' | 'not_yet' | 'backup_off' }

/** Pure core: the answer for one actor. The commands turn it into a refusal, the inbox into the "mine" flag. */
export function escalationStanding(actor: Actor, f: EscalationFacts): Standing {
  const res = { siteId: f.siteId }
  const primary = decide(actor, f.primary, res)
  if (primary.allowed) return { ok: true, via: 'primary' }
  const backup = decide(actor, BACKUP_ACTION, res)
  if (!backup.allowed) {
    return primary.reason === 'out_of_scope' || backup.reason === 'out_of_scope' ? { ok: false, kind: 'out_of_scope' } : { ok: false, kind: 'no_grant' }
  }
  if (!f.backupOn) return { ok: false, kind: 'backup_off' }
  return f.level >= 1 ? { ok: true, via: 'backup' } : { ok: false, kind: 'not_yet' }
}

/** What the inbox hands to a draft's `decidable` hook besides the viewer. */
export interface DecidableContext {
  clock: ApprovalClock
  /** The viewer's login, when the caller has it (the emergency rule compares the initiating login as well as the staff record). */
  userId?: string
}

/**
 * The inbox "mine" rule for a standard approval source (request, transfer, swap, extension): the escalation rule above AND not the person
 * it is about or the one who raised it. `backupOn` is read once by the source when it lists its items.
 */
export function mayDecideNow(actor: Actor, d: { primary: Action; siteId: string; backupOn: boolean; subjectStaffIds: readonly string[]; raisedByStaffId?: string }, ctx: DecidableContext): boolean {
  if (actor.staffId && (d.subjectStaffIds.includes(actor.staffId) || d.raisedByStaffId === actor.staffId)) return false
  return escalationStanding(actor, { primary: d.primary, siteId: d.siteId, level: ctx.clock.level, backupOn: d.backupOn }).ok
}

export const escalationBackupOn = (q: Reader): Promise<boolean> => getConfig(q, 'approvals.escalation_backup')

/** The approval clock of an item that has been waiting since `since`, on the site's calendar and the configured SLA. */
export async function clockSince(q: Reader, siteId: string, since: Date, now: Date): Promise<ApprovalClock> {
  return approvalClock(since.getTime(), now.getTime(), await getConfig(q, 'timers.routine_sla_business_days'), await loadCalendar(q, siteId))
}

/** Why the inbox card says "you cannot decide this yet" for someone who is in scope but not at the right level. */
export function waitingReason(first: string, backupOn: boolean): string {
  return backupOn
    ? `Waiting for ${first}. A Policy Approver or Backup Approver can decide it once it is routed to the backup level.`
    : `Waiting for ${first}. Backup approval is switched off (proposed policy P-01, pending client sign-off), so only ${first} decides.`
}

export interface AuthorizeEscalated {
  /** The primary decider's policy action. */
  primary: Action
  siteId: string
  /** When the item started waiting (request filed or last resubmitted, transfer raised or failed, extension requested). */
  since: Date
  /** Who decides first, in words: 'the Accommodation Admin', 'a Policy Approver'. */
  first: { text: string; owner: string }
  /** The broader actions that guard the routes which reach this decision: someone who holds one of them but no decision grant reads "not found". */
  guards?: readonly Action[]
}

/**
 * The standing of one actor on one item, reading the setting and (only when it matters) the clock. Commands, queries and screens
 * all go through here, so "may decide now" has a single definition.
 */
export async function standingNow(q: Reader, actor: Actor, o: { primary: Action; siteId: string; since: Date; now: Date }): Promise<Standing> {
  const backupOn = await escalationBackupOn(q)
  // The clock is only needed when the actor holds the backup grant but not the primary one: a primary decider never pays for the calendar lookup.
  const quick = escalationStanding(actor, { primary: o.primary, siteId: o.siteId, level: 2, backupOn })
  if (!(quick.ok && quick.via === 'backup')) return quick
  const level = (await clockSince(q, o.siteId, o.since, o.now)).level
  return escalationStanding(actor, { primary: o.primary, siteId: o.siteId, level, backupOn })
}

/**
 * A caller with no grant at all for this decision (neither the primary action nor the backup one, at any site) is refused before the
 * record is even looked up, so the answer cannot tell them whether the record exists. The routes that decide these items are guarded by
 * `approvals_inbox.view`, which people without any decision (Maintenance Coordinator, Auditor) also hold: for them an existing item and
 * a missing one both read "not found" (AT-002 style). Everyone else is "forbidden", as the route guard already says.
 */
export function noDecisionGrant(actor: Actor, primary: Action | readonly Action[]): Failure | undefined {
  const actions = Array.isArray(primary) ? primary as readonly Action[] : [primary as Action]
  return noGrantFor(actor, [...actions, BACKUP_ACTION], ['approvals_inbox.view'], `decide this (${actions.join(' or ')})`)
}

/**
 * The general form: the actor holds none of `actions` anywhere. If one of the broader `guards` (the action the route is guarded by) lets them
 * reach the command, the answer is "not found" for a record that exists and for one that does not; if not, "forbidden", as the route guard says.
 * Call it BEFORE the record is looked up, so the answer cannot say whether the record exists (AT-002 style).
 */
export function noGrantFor(actor: Actor, actions: readonly Action[], guards: readonly Action[], what?: string): Failure | undefined {
  if (actions.some(a => decide(actor, a).allowed)) return undefined
  return guards.some(a => decide(actor, a).allowed) ? fail.notFound() : fail.forbidden(what ?? `do this (${actions.join(' or ')})`)
}

/**
 * The command side: undefined when the actor may decide now, otherwise the refusal with reason, owner and next action.
 * Out of scope reads as "not found"; no grant is "forbidden"; in scope but too early (or backup approval off) is "forbidden"
 * with the owner named.
 */
export async function authorizeEscalated(c: Pick<CommandContext, 'actor' | 'tx' | 'now'>, o: AuthorizeEscalated): Promise<Failure | undefined> {
  const s = await standingNow(c.tx, c.actor, { primary: o.primary, siteId: o.siteId, since: o.since, now: c.now })
  if (s.ok) return undefined
  switch (s.kind) {
    case 'out_of_scope': return fail.notFound()
    case 'no_grant': {
      // No grant to decide this kind of item. Someone who can see it at its site is told so (403); someone the route let in for another site
      // reads "not found", exactly like a record that does not exist (never reveal existence).
      const seesIt = (o.guards ?? []).some(g => decide(c.actor, g, { siteId: o.siteId }).allowed)
      return seesIt ? fail.forbidden(`decide this (${o.primary})`) : noGrantFor(c.actor, [], o.guards ?? [], `decide this (${o.primary})`)
    }
    case 'backup_off':
      return failure('forbidden', `This is waiting for ${o.first.text}. Backup approval by a Policy Approver or Backup Approver is switched off (proposed policy P-01, pending client sign-off)`, {
        owner: o.first.owner, next: 'Ask them to decide, or ask a Super Admin about the backup approval setting',
      })
    case 'not_yet':
      return failure('forbidden', `This is waiting for ${o.first.text}. It reaches the backup approver after ${await getConfig(c.tx, 'timers.routine_sla_business_days')} business days`, {
        owner: o.first.owner, next: 'Ask them to decide, or wait for the reminder and escalation',
      })
  }
}
