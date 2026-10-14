/**
 * Emergency check-in rules (pure, no database): who decides at which level, and the hour-based clock.
 * D-66 to D-69 and D-26. Nothing here decides for a person: the clock only says when to remind and escalate.
 *
 * Clock (hours, 24/7, not business days): the case is created at T. Decision deadline = T + deadline hours (24).
 * Reminder 1 is due at the deadline; reminder n at deadline + (n - 1) x re-alert hours (24). Escalation level 1
 * (the authorised backup) once `escalateAfter` (2) reminders have gone out without a decision, level 2 (Policy Approver
 * and Super Admin, critical) with the next one. Same cadence as the prototype (prototype/src/domain/store.ts).
 */
import type { Capability, Role } from '@/domain/enums'
import type { Actor } from '@/server/policy'
import { can } from '@/server/policy'
import type { EmergencyRoute, EmergencyVia } from '@/server/db/schema.emergency'

export const HOUR = 3_600_000

export interface EmergencyTiming { deadlineHours: number; realertHours: number; escalateAfter: number }

/** The route that decides, by the initiator's role (D-68): an AA's own initiation goes to a Policy Approver. */
export const routeFor = (initiatorRole: Role): EmergencyRoute => (initiatorRole === 'AA' ? 'PA' : 'AA')

export const deadlineFor = (createdMs: number, t: EmergencyTiming): number => createdMs + t.deadlineHours * HOUR

/** How many reminders are due at `nowMs` (0 before the deadline). */
export function dueReminders(deadlineMs: number, nowMs: number, t: EmergencyTiming): number {
  if (nowMs < deadlineMs) return 0
  return 1 + Math.floor((nowMs - deadlineMs) / (t.realertHours * HOUR))
}
export const reminderDueAt = (deadlineMs: number, n: number, t: EmergencyTiming): number => deadlineMs + (n - 1) * t.realertHours * HOUR

/** Escalation level once `reminders` have gone unanswered: 0 none, 1 backup, 2 final (Policy Approver / Super Admin). */
export function escalationFor(reminders: number, t: EmergencyTiming): 0 | 1 | 2 {
  return reminders > t.escalateAfter ? 2 : reminders >= t.escalateAfter ? 1 : 0
}

/** Who is asked at each level. Labels are roles and capabilities, never names (GH-07 is open). */
export const LEVEL_LABEL = ['Primary approver', 'Authorised backup approver', 'Policy Approver / Super Admin'] as const
export function primaryLabel(route: EmergencyRoute): string { return route === 'AA' ? 'Accommodation Admin' : 'Policy Approver' }

export interface DecideFacts {
  route: EmergencyRoute
  escalation: number
  siteId: string
  initiatedBy: string
  initiatedByStaffId: string | null
  subjectStaffId: string
}
export interface WhoAmI { actor: Actor; userId: string }

export type Standing =
  | { ok: true; via: EmergencyVia }
  | { ok: false; kind: 'initiator' | 'subject' | 'no_action' | 'not_on_route'; why: string; owner: string; next: string }

/**
 * May this person decide this case right now, and on what basis? Order of checks (the first failure is the answer):
 *  1. they started it or are the person it is about: never (D-26, AT-017),
 *  2. they hold no emergency approval action at the case's site,
 *  3. the route: Reception-initiated is decided by an AA; AA-initiated by a Policy Approver. From the first escalation the
 *     authorised backup (BackupApprover) may also decide, and from then on the Policy Approver too on an AA route.
 * A Super Admin is told at the last level but decides nothing here unless they also hold a capability: the permission matrix
 * gives SA configuration only (D-25), see the README note for the product owner.
 */
export function standing(who: WhoAmI, c: DecideFacts): Standing {
  const { actor, userId } = who
  if (c.initiatedBy === userId || (c.initiatedByStaffId !== null && actor.staffId === c.initiatedByStaffId)) {
    return { ok: false, kind: 'initiator', why: 'You started this emergency check-in, so you cannot decide it (separation of duties, D-26)', owner: routeOwner(c), next: `${routeOwner(c)} decides it${c.escalation > 0 ? ' or the escalated approver' : ''}` }
  }
  if (actor.staffId === c.subjectStaffId) {
    return { ok: false, kind: 'subject', why: 'This stay is yours, so you cannot decide it (separation of duties, D-26)', owner: routeOwner(c), next: 'An independent approver decides it' }
  }
  if (!can(actor, 'emergency_checkin.approve', { siteId: c.siteId })) {
    return { ok: false, kind: 'no_action', why: 'Your role cannot approve emergency check-ins at this site', owner: routeOwner(c), next: `${routeOwner(c)} decides it` }
  }
  const has = (cap: Capability) => actor.caps.includes(cap)
  if (c.route === 'AA' && actor.role === 'AA') return { ok: true, via: 'AA' }
  if (has('PolicyApprover') && (c.route === 'PA' || c.escalation >= 1)) return { ok: true, via: 'PolicyApprover' }
  if (has('BackupApprover') && c.escalation >= 1) return { ok: true, via: 'BackupApprover' }
  const needs = c.route === 'AA'
    ? c.escalation >= 1 ? 'an Accommodation Admin, the backup approver or a Policy Approver' : 'an Accommodation Admin'
    : c.escalation >= 1 ? 'a Policy Approver or the backup approver' : 'a Policy Approver'
  return {
    ok: false, kind: 'not_on_route',
    why: c.route === 'PA' && actor.role === 'AA'
      ? 'An Accommodation Admin started this emergency check-in, so it goes to a Policy Approver, not to an Accommodation Admin (D-68)'
      : `This case is currently routed to ${needs}`,
    owner: routeOwner(c),
    next: c.escalation === 0 ? `${primaryLabel(c.route)} decides it. It reaches the backup approver if it stays unanswered` : 'The escalated approver decides it',
  }
}

function routeOwner(c: Pick<DecideFacts, 'route' | 'escalation'>): string {
  return c.escalation >= 1 ? LEVEL_LABEL[Math.min(c.escalation, 2)] : primaryLabel(c.route)
}

/** May this actor see emergency cases at all (list, detail)? Initiators see the ones they started. */
export const mayUseEmergency = (actor: Actor): boolean =>
  can(actor, 'emergency_checkin.view') || can(actor, 'emergency_checkin.approve') || can(actor, 'emergency_checkin.initiate')
