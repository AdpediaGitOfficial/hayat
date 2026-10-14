import type { Capability, Role } from '@/domain/enums'
import type { ApprovalClock, ApprovalLevel } from '@/domain/approvals'
import type { Db } from '@/server/db/client'
import type { Action, Actor } from '@/server/policy'
import type { DecidableContext } from './escalation'

/** Who may decide at an escalation level (0 primary, 1 backup, 2 final), and who gets the reminder when it gets there. */
export interface Decider {
  level: ApprovalLevel
  label: string
  /** The policy action that makes someone able to decide at this level (scope comes from the actor's own sites). */
  action: Action
  /** Recipient of reminders and escalations at this level. */
  notify: Role | Capability
}

/** One pending decision, as a package describes it. The framework adds the SLA clock, visibility and "why you can't". */
export interface ApprovalDraft {
  kind: string
  ref: string
  siteId: string
  /** People the record is about, and the person who raised it: none of them may decide it (D-26). */
  subjectStaffIds: string[]
  raisedByStaffId?: string
  title: string
  sub: string
  createdAt: number
  deciders: Decider[]
  urgent?: boolean
  href: string
  /** Sources with their own clock (emergency: hours, not business days) supply it; the generic sweep then skips the item. */
  ownClock?: ApprovalClock
  /**
   * Exactly who may decide this item right now, for sources whose rule is more than "holds the action at a level the clock has reached"
   * (escalation backup, P-01; the emergency route). When present the inbox uses it for the "mine" flag, so the card and the command
   * cannot disagree. It must apply the same rule the command applies, scope and separation of duties included.
   */
  decidable?: (actor: Actor, ctx: DecidableContext) => boolean
  /** The words for "you are in scope but cannot decide it yet", when the generic "waiting for the next level" would be untrue. */
  whyNot?: (actor: Actor, ctx: DecidableContext) => string | undefined
}

export interface ApprovalSource {
  kind: string
  /** Every pending item of this kind, unscoped. The inbox scopes and annotates; the sweep reminds. */
  listPending(db: Pick<Db, 'select'>, now: Date): Promise<ApprovalDraft[]>
}

export interface InboxItem extends Omit<ApprovalDraft, 'deciders' | 'ownClock'> {
  clock: ApprovalClock
  /** Who currently owns the decision. */
  current: string
  primary: string
  backup: string
  /** The viewer may decide it right now. */
  mine: boolean
  /** When they cannot: the reason, shown on the card. */
  why?: string
}
