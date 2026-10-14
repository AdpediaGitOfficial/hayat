/**
 * Stay extension (D-57). The resident (own stay) or an Accommodation Admin asks for a later departure day.
 *  - Validated on request: the stay is active and has a planned end, the bed is free for the added period, the person is still
 *    eligible, nothing is booked on the bed in that period. If the NEXT BOOKING on the bed clashes, the request is kept and the
 *    answer carries a transfer suggestion (beds that are free for the whole stay) instead of a bare refusal.
 *  - Routed by size: within `stays.extension_policy_days` the Accommodation Admin decides; beyond it the Policy Approver does,
 *    and a reason is mandatory. Nobody decides their own (D-26). Approval changes the stay's claim period (the exclusion
 *    constraint is the last guard) and re-validates everything at that moment.
 *  - A timeout never approves or rejects it; the approvals sweep only reminds and escalates.
 */
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { extensionRequest } from '@/server/db/schema.stays'
import { audit } from '@/server/audit'
import { runCommand } from '@/server/command/run'
import type { CommandContext, RequestContext } from '@/server/command/context'
import { fail, ok, type Failure, type Result } from '@/server/command/result'
import { overlappingClaims, setClaimPeriod, suggestBeds, type BedSuggestion } from '@/server/allocation'
import { checkEligibility } from '@/server/eligibility'
import { getConfig } from '@/server/config/registry'
import { notify } from '@/server/notify'
import { guardUnique } from '@/server/commands/property/shared'
import { extensionSize, dayDiff } from './rules'
import { authorizeAny, authorizeDecision, dateSchema, idSchema, loadStayLocked, lockBeds, notInvolved, reasonSchema, siteToday, staffName, type StayFull } from './shared'
import { guarded } from './transferShared'

export interface ExtensionClash {
  reason: 'next_booking'
  conflicts: { kind: string; from: string; to: string | null }[]
  /** Beds that are ready and free for the whole remaining stay including the extension: the transfer to offer instead. */
  suggestions: BedSuggestion[]
  message: string
}

export const input = z.object({
  stayId: idSchema,
  newEnd: dateSchema,
  reason: z.string().trim().max(500, 'At most 500 characters').nullish().transform(v => (v ? v : null)),
})
export type RequestExtensionInput = z.infer<typeof input>
export interface RequestExtensionOut {
  id: string
  status: 'requested'
  addedDays: number
  beyondPolicy: boolean
  /** Who will decide it. */
  route: 'accommodation_admin' | 'policy_approver'
  clash: ExtensionClash | null
  /** Set when the bed is not free: open a transfer with these beds (requestTransfer with linkedExtensionId). */
  transferSuggestion: { stayId: string; extensionRequestId: string; beds: BedSuggestion[] } | null
}

const REQUESTERS = ['reservations_stays.request_extension', 'reservations_stays.approve_extension'] as const

export function requestExtension(rc: RequestContext, i: RequestExtensionInput): Promise<Result<RequestExtensionOut>> {
  return runCommand(rc, async c => {
    const s = await loadStayLocked(c.tx, i.stayId)
    if (!s) return fail.notFound()
    const denied = authorizeAny(c, REQUESTERS, { siteId: s.siteId, ownerStaffId: s.staffId })
    if (denied) return denied
    if (s.status !== 'active') return fail.conflict(`The stay is ${s.status.replace('_', ' ')}, so it cannot be extended`, 'Accommodation Admin', 'Only an active stay can be extended')
    if (s.to === null) return fail.conflict('This stay has no end date, so there is nothing to extend', 'Accommodation Admin', 'Open-ended stays are reviewed on their review date instead', { reason: 'open_ended' })

    const today = await siteToday(c.tx, s.siteId, c.now)
    if (i.newEnd <= s.to) return fail.invalid('The new end date must be after the current one', { newEnd: `Choose a day after ${s.to}` })
    if (i.newEnd <= today) return fail.invalid('The new end date is already past', { newEnd: `Choose a day after ${today}` })
    const policyDays = await getConfig(c.tx, 'stays.extension_policy_days')
    const { addedDays, beyondPolicy } = extensionSize(s.to, i.newEnd, policyDays)
    if (beyondPolicy && !i.reason) return fail.invalid(`An extension of more than ${policyDays} days needs a reason`, { reason: 'Say why the stay needs to be this long' })

    const e = await checkEligibility(c.tx, s.staffId, s.bedId, c.now)
    if (!e) return fail.notFound()
    if (!e.ok) {
      return fail.conflict(`The resident is no longer eligible for this bed: ${e.reasons.join('; ')}`, e.exceptionable ? 'Policy Approver' : 'Accommodation Admin',
        e.exceptionable ? 'Ask a Policy Approver for an exception, or move the resident to a suitable bed' : 'Not eligible for accommodation', { reason: 'not_eligible', failed: e.failed })
    }

    const clash = await findClash(c, s, i.newEnd, today)
    const created = await guardUnique(c.tx, q => q.insert(extensionRequest).values({
      siteId: s.siteId, stayId: s.id, staffId: s.staffId, requestedBy: c.user.id, requestedByStaffId: c.actor.staffId ?? null,
      currentEnd: s.to!, newEnd: i.newEnd, addedDays, beyondPolicy, reason: i.reason, status: 'requested', clash, createdAt: c.now,
    }).returning({ id: extensionRequest.id }))
    if (!created) return fail.conflict('There is already an open extension request for this stay', 'Accommodation Admin', 'Decide or cancel that one first', { reason: 'open_extension' })
    const id = created[0].id

    const who = await staffName(c.tx, s.staffId)
    const route = beyondPolicy ? 'policy_approver' as const : 'accommodation_admin' as const
    await audit(c, {
      action: 'stays.extension.requested', entityType: 'extension_request', entityId: id, siteId: s.siteId, reason: i.reason ?? undefined,
      after: { stayId: s.id, currentEnd: s.to, newEnd: i.newEnd, addedDays, beyondPolicy, route, clash: clash ? clash.conflicts : null },
    })
    await notify(c.tx, {
      dedupeKey: `extension:${id}:requested`, kind: 'extension.requested', to: beyondPolicy ? { role: 'PolicyApprover', siteId: s.siteId } : { role: 'AA', siteId: s.siteId },
      ref: { type: 'extension_request', id }, text: `Extension requested for ${who}: until ${i.newEnd} (+${addedDays} days${beyondPolicy ? ', beyond policy' : ''})${clash ? '. The bed is booked next: a transfer is suggested' : ''}.`,
    })
    if (c.actor.staffId !== s.staffId) {
      await notify(c.tx, { dedupeKey: `extension:${id}:requested:resident`, kind: 'extension.requested', to: { staffId: s.staffId }, ref: { type: 'extension_request', id }, text: `An extension of your stay until ${i.newEnd} was requested for you.` })
    }
    return ok({
      id, status: 'requested' as const, addedDays, beyondPolicy, route, clash,
      transferSuggestion: clash ? { stayId: s.id, extensionRequestId: id, beds: clash.suggestions } : null,
    }, clash
      ? 'Extension requested, but the next booking on this bed clashes. A transfer to a free bed is suggested.'
      : `Extension requested. ${beyondPolicy ? 'A Policy Approver' : 'An Accommodation Admin'} decides it.`)
  })
}

/** Is the bed free for [currentEnd, newEnd)? If not, what is in the way and which beds could hold the whole remaining stay. */
async function findClash(c: CommandContext, s: StayFull, newEnd: string, today: string): Promise<ExtensionClash | null> {
  const conflicts = await overlappingClaims(c.tx, s.bedId, s.to!, newEnd, [s.claimId])
  if (conflicts.length === 0) return null
  const from = today < s.to! ? (today > s.from ? today : s.from) : s.to!
  const beds = (await suggestBeds(c.tx, { staffId: s.staffId, siteId: s.siteId, from, to: newEnd, limit: 8, excludeBedIds: [s.bedId], now: c.now })).filter(b => b.state === 'available').slice(0, 3)
  const first = conflicts.slice().sort((a, b) => a.from.localeCompare(b.from))[0]
  return {
    reason: 'next_booking',
    conflicts: conflicts.map(x => ({ kind: x.kind, from: x.from, to: x.to })),
    suggestions: beds,
    message: `This bed is ${first.kind === 'offer_hold' ? 'held for a bed offer' : 'booked'} from ${first.from}${dayDiff(s.to!, first.from) > 0 ? `, ${dayDiff(s.to!, first.from)} day(s) after the current end` : ''}.`,
  }
}

/* ---------------- decide ---------------- */

export const approveInput = z.object({ id: idSchema, note: z.string().trim().max(500).nullish().transform(v => (v ? v : null)) })
export type ApproveExtensionInput = z.infer<typeof approveInput>

async function loadDecidable(c: CommandContext, id: string): Promise<{ e: typeof extensionRequest.$inferSelect } | Failure> {
  const [e] = await c.tx.select().from(extensionRequest).where(eq(extensionRequest.id, id)).limit(1).for('update')
  if (!e) return fail.notFound()
  const denied = await authorizeDecision(c, { kind: e.beyondPolicy ? 'extension_beyond' : 'extension', siteId: e.siteId, since: e.createdAt })
  if (denied) return denied
  const self = notInvolved(c, [e.staffId, e.requestedByStaffId], 'decide this extension')
  if (self) return self
  if (e.status !== 'requested') return fail.conflict(`This extension request is already ${e.status}`, 'Accommodation Admin', 'Nothing more to do')
  return { e }
}

export function approveExtension(rc: RequestContext, i: ApproveExtensionInput): Promise<Result<{ id: string; status: 'approved'; newEnd: string }>> {
  return runCommand(rc, async c => {
    const l = await loadDecidable(c, i.id)
    if ('ok' in l) return l
    const e = l.e
    const s = await loadStayLocked(c.tx, e.stayId)
    if (!s || s.status !== 'active') return fail.conflict('The stay is no longer active', 'Accommodation Admin', 'Reject the request; nothing was extended', { reason: 'stale' })
    if (s.to !== e.currentEnd) return fail.conflict(`The stay's end date changed to ${s.to ?? 'open-ended'} since this was requested`, 'Accommodation Admin', 'Reject this request and ask for a new one', { reason: 'stale', currentEnd: s.to })
    const [b] = await lockBeds(c.tx, [s.bedId])
    if (!b) return fail.notFound()

    const el = await checkEligibility(c.tx, s.staffId, s.bedId, c.now)
    if (!el) return fail.notFound()
    if (!el.ok) return fail.conflict(`The resident is no longer eligible for this bed: ${el.reasons.join('; ')}`, 'Accommodation Admin', 'Reject the request, or ask a Policy Approver for an exception', { reason: 'not_eligible', failed: el.failed })

    const today = await siteToday(c.tx, s.siteId, c.now)
    const clash = await findClash(c, s, e.newEnd, today)
    if (clash) {
      return fail.conflict(`The bed is no longer free until ${e.newEnd}. ${clash.message}`, 'Accommodation Admin',
        clash.suggestions.length ? 'Open a transfer to one of the suggested beds; the extension can then be approved on the new bed' : 'Open a transfer to another free bed, or approve a shorter stay',
        { ...clash, reason: 'bed_clash', extensionRequestId: e.id })
    }
    const moved = await guarded(c, async c2 => { await setClaimPeriod(c2.tx, s.claimId, s.from, e.newEnd); return ok(true) })
    if (!moved.ok) return moved

    await c.tx.update(extensionRequest).set({ status: 'approved', decidedBy: c.user.id, decidedAt: c.now, decisionReason: i.note }).where(eq(extensionRequest.id, e.id))
    await audit(c, {
      action: 'stays.extension.approved', entityType: 'extension_request', entityId: e.id, siteId: e.siteId, reason: i.note ?? e.reason ?? undefined,
      before: { status: 'requested', end: e.currentEnd }, after: { status: 'approved', end: e.newEnd, stayId: s.id, beyondPolicy: e.beyondPolicy },
    })
    await notify(c.tx, { dedupeKey: `extension:${e.id}:approved`, kind: 'extension.approved', to: { staffId: e.staffId }, ref: { type: 'stay', id: s.id }, text: `Your stay is extended until ${e.newEnd}.` })
    return ok({ id: e.id, status: 'approved' as const, newEnd: e.newEnd }, `Stay extended until ${e.newEnd}.`)
  })
}

export const rejectInput = z.object({ id: idSchema, reason: reasonSchema })
export type RejectExtensionInput = z.infer<typeof rejectInput>

export function rejectExtension(rc: RequestContext, i: RejectExtensionInput): Promise<Result<{ id: string; status: 'rejected' }>> {
  return runCommand(rc, async c => {
    const l = await loadDecidable(c, i.id)
    if ('ok' in l) return l
    const e = l.e
    await c.tx.update(extensionRequest).set({ status: 'rejected', decidedBy: c.user.id, decidedAt: c.now, decisionReason: i.reason }).where(eq(extensionRequest.id, e.id))
    await audit(c, { action: 'stays.extension.rejected', entityType: 'extension_request', entityId: e.id, siteId: e.siteId, reason: i.reason, before: { status: 'requested' }, after: { status: 'rejected' } })
    await notify(c.tx, { dedupeKey: `extension:${e.id}:rejected`, kind: 'extension.rejected', to: { staffId: e.staffId }, ref: { type: 'extension_request', id: e.id }, text: `Your extension request was not approved: ${i.reason}. Your stay still ends on ${e.currentEnd}.` })
    return ok({ id: e.id, status: 'rejected' as const }, 'Extension rejected. The stay keeps its current end date.')
  })
}
