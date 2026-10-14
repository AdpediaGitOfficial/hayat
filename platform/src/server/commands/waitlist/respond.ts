/**
 * The resident's answer to a bed offer: accept (D-49, D-52) or decline (D-50, AT-012, AT-013).
 * Accepting converts the hold in place into the reservation's claim (convertClaim), so the bed is never free in between.
 */
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { accommodationRequest, reservation } from '@/server/db/schema'
import { bedOffer, waitlistEntry, waitlistPriorityRequest } from '@/server/db/schema.waitlist'
import { audit } from '@/server/audit'
import { authorize, notSelf } from '@/server/command/authorize'
import { runCommand } from '@/server/command/run'
import type { CommandContext, RequestContext } from '@/server/command/context'
import { fail, ok, type Result } from '@/server/command/result'
import { convertClaim } from '@/server/allocation'
import { checkEligibility, recordExceptionUse } from '@/server/eligibility'
import { getConfig } from '@/server/config/registry'
import { notify } from '@/server/notify'
import { decide } from '@/server/policy'
import { alreadyHoused, notifyFreedBed, queuePosition } from './queue'
import { bedLabel, claimDates, endOffer, etaFor, idSchema, loadOfferLocked, noteSchema, staffName } from './shared'

export interface AcceptOut { offerId: string; reservationId: string; bedId: string; claimId: string; from: string; to: string | null; onBehalf: boolean; repeated: boolean }

async function acceptIn(c: CommandContext, offerId: string, mode: { kind: 'self' } | { kind: 'behalf'; consent: string }): Promise<Result<AcceptOut>> {
  const l = await loadOfferLocked(c.tx, offerId)
  if (!l) return fail.notFound()
  const { offer, entry } = l
  const lbl = await bedLabel(c.tx, offer.bedId)
  const res = { siteId: lbl.siteId, ownerStaffId: offer.staffId }

  if (mode.kind === 'self') {
    const denied = authorize(c, 'requests_waitlist.respond_offer', res)
    if (denied) return denied
  } else {
    const may = decide(c.actor, 'requests_waitlist.accept_offer_on_behalf', res).allowed || decide(c.actor, 'requests_waitlist.manage_offers', res).allowed
    if (!may) return authorize(c, 'requests_waitlist.accept_offer_on_behalf', res)!
    const sod = notSelf(c, offer.staffId, 'accept an offer on your own behalf this way')
    if (sod) return sod
  }
  const onBehalf = mode.kind === 'behalf'

  if (offer.status === 'accepted') {
    // A retry by whoever accepted it: the answer is the reservation that already exists, nothing is written twice (AT-030).
    if (offer.acceptedBy !== c.user.id) return fail.conflict('This offer was already accepted', 'Accommodation Admin', 'Nothing more to do', { reason: 'already_accepted' })
    const [r] = await c.tx.select({ id: reservation.id }).from(reservation).where(eq(reservation.claimId, offer.claimId)).limit(1)
    const d = await claimDates(c.tx, offer.claimId)
    return ok({ offerId: offer.id, reservationId: r?.id ?? '', bedId: offer.bedId, claimId: offer.claimId, from: d?.from ?? '', to: d?.to ?? null, onBehalf: offer.acceptedOnBehalf, repeated: true }, 'Already accepted')
  }
  if (offer.status !== 'pending') {
    return fail.conflict(`This offer is ${offer.status}${offer.status === 'expired' ? ': the 48 hours ended' : ''}`, 'Accommodation Admin', 'Ask the Accommodation Admin whether a new offer is possible; you keep your place on the waitlist if the entry is still valid', { reason: `offer_${offer.status}` })
  }
  if (offer.expiresAt && offer.expiresAt.getTime() <= c.now.getTime()) {
    return fail.conflict('The 48 hours for this offer have ended', 'Accommodation Admin', 'Ask the Accommodation Admin whether a new offer is possible', { reason: 'offer_expired' })
  }
  if (!entry || entry.status !== 'offered') return fail.conflict('The waitlist entry behind this offer is no longer open', 'Accommodation Admin', 'Ask the Accommodation Admin for help', { reason: 'entry_closed' })

  // Accept only after revalidation (SRS section 6): the person is still eligible and has no other bed or reservation.
  const el = await checkEligibility(c.tx, offer.staffId, offer.bedId, c.now, { requestId: entry.requestId ?? undefined })
  if (!el) return fail.notFound()
  if (!el.ok) {
    return fail.conflict(`This offer can no longer be accepted: ${el.reasons.join('; ')}`, el.exceptionable ? 'Policy Approver' : 'Accommodation Admin',
      el.exceptionable ? 'Ask a Policy Approver for an exception, or withdraw the offer' : 'Withdraw the offer', { reason: 'not_eligible', failed: el.failed })
  }
  if (await alreadyHoused(c.tx, offer.staffId)) return fail.conflict('This person already has a reservation or a bed', 'Accommodation Admin', 'Resolve that first, or withdraw the offer', { reason: 'already_housed' })

  const d = await claimDates(c.tx, offer.claimId)
  if (!d) return fail.notFound()
  await convertClaim(c.tx, offer.claimId, 'reservation')
  const [r] = await c.tx.insert(reservation).values({
    requestId: entry.requestId, staffId: offer.staffId, bedId: offer.bedId, claimId: offer.claimId, eta: etaFor(d.from),
    source: 'offer', stayType: entry.stayType, createdBy: c.user.id,
  }).returning({ id: reservation.id })
  await recordExceptionUse(c.tx, el.exceptionIds, { for: 'reservation', ref: r.id, by: c.user.id })

  await c.tx.update(bedOffer).set({
    status: 'accepted', acceptedBy: c.user.id, acceptedOnBehalf: onBehalf, consentNote: mode.kind === 'behalf' ? mode.consent : null, respondedAt: c.now,
    ...(offer.deliveredAt ? {} : { deliveredAt: c.now, deliveredVia: onBehalf ? 'offline' as const : 'viewed' as const, deliveredBy: onBehalf ? c.user.id : null, deliveryNote: onBehalf ? 'Accepted on behalf with consent' : null }),
  }).where(eq(bedOffer.id, offer.id))
  await c.tx.update(waitlistEntry).set({ status: 'closed', closeReason: 'offer_accepted', closedAt: c.now }).where(eq(waitlistEntry.id, entry.id))
  await c.tx.update(waitlistPriorityRequest).set({ status: 'withdrawn' }).where(and(eq(waitlistPriorityRequest.entryId, entry.id), eq(waitlistPriorityRequest.status, 'pending')))
  if (entry.requestId) {
    // The Accommodation Admin who chose the bed made the allocation decision; the resident's acceptance completes it.
    await c.tx.update(accommodationRequest).set({ status: 'approved', decidedBy: offer.createdBy, decidedAt: c.now, decisionReason: 'Bed offer accepted' })
      .where(and(eq(accommodationRequest.id, entry.requestId), eq(accommodationRequest.status, 'waitlisted')))
  }

  await audit(c, {
    action: onBehalf ? 'waitlist.offer.accepted_on_behalf' : 'waitlist.offer.accepted', entityType: 'bed_offer', entityId: offer.id, siteId: lbl.siteId,
    reason: mode.kind === 'behalf' ? mode.consent : undefined,
    before: { status: 'pending', entryStatus: 'offered' },
    after: { status: 'accepted', reservationId: r.id, bedId: offer.bedId, bed: lbl.code, from: d.from, to: d.to, acceptedBy: c.user.id, onBehalf, consent: mode.kind === 'behalf' ? mode.consent : null },
  })
  await notify(c.tx, {
    dedupeKey: `offer:${offer.id}:accepted`, kind: 'offer.accepted', to: { staffId: offer.staffId },
    text: `Your bed is reserved: ${lbl.code} (${lbl.roomName}) from ${d.from}${onBehalf ? ' (accepted for you by staff, with your consent)' : ''}. Reception will check you in on arrival.`,
    ref: { type: 'reservation', id: r.id },
  })
  await notify(c.tx, {
    dedupeKey: `offer:${offer.id}:accepted:staff`, kind: 'offer.accepted', to: { role: 'Rec', siteId: lbl.siteId },
    text: `${await staffName(c.tx, offer.staffId)} accepted bed ${lbl.code} from ${d.from}${onBehalf ? ' (on their behalf)' : ''}. Expect them at check-in.`, ref: { type: 'reservation', id: r.id },
  })
  return ok({ offerId: offer.id, reservationId: r.id, bedId: offer.bedId, claimId: offer.claimId, from: d.from, to: d.to, onBehalf, repeated: false }, `Reserved bed ${lbl.code} from ${d.from}`)
}

export const acceptInput = z.object({ offerId: idSchema })

/** The offered resident accepts: the hold becomes their reservation in one step. Retrying changes nothing. */
export function acceptOffer(rc: RequestContext, i: z.infer<typeof acceptInput>): Promise<Result<AcceptOut>> {
  return runCommand(rc, c => acceptIn(c, i.offerId, { kind: 'self' }))
}

export const acceptBehalfInput = z.object({
  offerId: idSchema,
  /** The resident's consent, how and when it was given ("said yes by phone at 14:10"). Mandatory and audited (D-52). */
  consent: noteSchema,
})

/** Reception or an Accommodation Admin accepts for the resident, with their consent recorded (D-52). Never for oneself. */
export function acceptOfferOnBehalf(rc: RequestContext, i: z.infer<typeof acceptBehalfInput>): Promise<Result<AcceptOut>> {
  return runCommand(rc, c => acceptIn(c, i.offerId, { kind: 'behalf', consent: i.consent }))
}

export const declineInput = z.object({ offerId: idSchema, reason: z.string().trim().max(500).optional() })
export interface DeclineOut { offerId: string; declines: number; requeued: boolean; positionBefore: number; positionAfter: number; repeated: boolean }

/**
 * The offered resident declines. FIRST decline: the hold is released, the entry stays active in the SAME queue position and
 * that bed is skipped for them (AT-012). SECOND (and later) decline (timers.max_declines_before_requeue): the entry moves to
 * the back of the queue; the audit records the prior and the new sequence number (AT-013). The count keeps rising, so every
 * further decline also goes to the back (the Grand Hyatt question "any limit on future offers" is still open).
 */
export function declineOffer(rc: RequestContext, i: z.infer<typeof declineInput>): Promise<Result<DeclineOut>> {
  return runCommand<DeclineOut>(rc, async c => {
    const l = await loadOfferLocked(c.tx, i.offerId)
    if (!l) return fail.notFound()
    const { offer, entry } = l
    const lbl = await bedLabel(c.tx, offer.bedId)
    const denied = authorize(c, 'requests_waitlist.respond_offer', { siteId: lbl.siteId, ownerStaffId: offer.staffId })
    if (denied) return denied

    const max = await getConfig(c.tx, 'timers.max_declines_before_requeue')
    if (offer.status === 'declined' && entry) {
      const pos = (await queuePosition(c.tx, entry.siteId, entry.id)) ?? 0
      return ok({ offerId: offer.id, declines: entry.declines, requeued: entry.declines >= max, positionBefore: pos, positionAfter: pos, repeated: true }, 'Already declined')
    }
    if (offer.status !== 'pending') return fail.conflict(`This offer is ${offer.status}`, 'Accommodation Admin', 'There is nothing to decline', { reason: `offer_${offer.status}` })
    if (offer.expiresAt && offer.expiresAt.getTime() <= c.now.getTime()) {
      return fail.conflict('The 48 hours for this offer have ended', 'Accommodation Admin', 'The offer is closed; you keep your place if the entry is still valid', { reason: 'offer_expired' })
    }
    if (!entry || entry.status !== 'offered') return fail.conflict('The waitlist entry behind this offer is no longer open', 'Accommodation Admin', 'Ask the Accommodation Admin for help', { reason: 'entry_closed' })

    const declines = entry.declines + 1
    const requeue = declines >= max
    const before = (await queuePosition(c.tx, entry.siteId, entry.id)) ?? 0
    await endOffer(c.tx, offer, { status: 'declined', note: i.reason?.trim() || 'Declined by the resident', now: c.now, respondedAt: true })
    await c.tx.update(waitlistEntry).set({
      status: 'waiting', declines, skipBedIds: entry.skipBedIds.includes(offer.bedId) ? entry.skipBedIds : [...entry.skipBedIds, offer.bedId],
      ...(requeue ? { queueTs: c.now } : {}),
    }).where(eq(waitlistEntry.id, entry.id))
    const after = (await queuePosition(c.tx, entry.siteId, entry.id)) ?? 0

    await audit(c, {
      action: requeue ? 'waitlist.offer.declined_requeued' : 'waitlist.offer.declined', entityType: 'bed_offer', entityId: offer.id, siteId: entry.siteId, reason: i.reason,
      before: { status: 'pending', declines: entry.declines, sequence: before, queueTs: entry.queueTs.toISOString() },
      after: { status: 'declined', declines, entryId: entry.id, bedSkipped: lbl.code, requeued: requeue, priorSequence: before, newSequence: after, queueTs: (requeue ? c.now : entry.queueTs).toISOString() },
    })
    await notify(c.tx, {
      dedupeKey: `offer:${offer.id}:declined`, kind: 'offer.declined', to: { staffId: offer.staffId },
      text: requeue
        ? `You declined bed ${lbl.code}. This was your decline number ${declines}, so you moved to the back of the queue (position ${after}). You stay on the waitlist until it expires.`
        : `You declined bed ${lbl.code}. This was your first decline, so you keep your place in the queue (position ${after}). Another decline moves you to the back.`,
      ref: { type: 'waitlist_entry', id: entry.id },
    })
    await notifyFreedBed(c.tx, offer.bedId, c.now, `offer:${offer.id}:declined`)
    return ok({ offerId: offer.id, declines, requeued: requeue, positionBefore: before, positionAfter: after, repeated: false },
      requeue ? `Declined. You moved to the back of the queue (position ${after})` : `Declined. You keep your place (position ${after})`)
  })
}
