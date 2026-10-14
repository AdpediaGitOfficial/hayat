import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { bed, site } from '@/server/db/schema'
import { bedOffer, waitlistEntry } from '@/server/db/schema.waitlist'
import { audit } from '@/server/audit'
import { authorize, notSelf } from '@/server/command/authorize'
import { runCommand } from '@/server/command/run'
import type { CommandContext, RequestContext } from '@/server/command/context'
import { done, fail, ok, type Result } from '@/server/command/result'
import { allocateBed } from '@/server/allocation'
import { notify } from '@/server/notify'
import { todayInZone } from '@/server/commands/property/shared'
import { alreadyHoused, matchFreedBed, queuePosition } from './queue'
import { offerNotReady } from './offerReadiness'
import { bedLabel, claimDates, endOffer, idSchema, loadEntry, loadOfferLocked, offerWindow, pendingOfferOf, reasonSchema, staffName } from './shared'

export interface OfferOut { offerId: string; entryId: string; bedId: string; claimId: string; from: string; to: string | null; created: boolean }

export const createInput = z.object({
  entryId: idSchema,
  bedId: idSchema,
  /** Needed only when someone else is ahead in the queue for this bed: a manual override with a reason (SRS section 7), audited. */
  overrideReason: reasonSchema.optional(),
})
export type CreateOfferInput = z.infer<typeof createInput>

/**
 * Offers a freed bed to a waitlisted person. The bed is HELD (an `offer_hold` claim through allocateBed), so nobody else
 * can allocate it until the offer is accepted, declined, withdrawn or expires. The offer only holds: it never decides for
 * the person, and the 48-hour timer does not start until delivery is confirmed (D-49, D-51).
 * Safe to retry: the same entry and bed answers with the offer that already exists.
 */
export function createOffer(rc: RequestContext, i: CreateOfferInput): Promise<Result<OfferOut>> {
  return runCommand(rc, c => createOfferIn(c, i))
}

export async function createOfferIn(c: CommandContext, i: CreateOfferInput): Promise<Result<OfferOut>> {
  const peek = await loadEntry(c.tx, i.entryId)
  if (!peek) return fail.notFound()
  const denied = authorize(c, 'requests_waitlist.manage_offers', { siteId: peek.siteId })
  if (denied) return denied
  const sod = notSelf(c, peek.staffId, 'offer a bed')
  if (sod) return sod

  const e = await loadEntry(c.tx, i.entryId, true)
  if (!e) return fail.notFound()
  if (e.status === 'closed') return fail.conflict(`This waitlist entry is closed (${e.closeReason ?? 'closed'})`, 'Accommodation Admin', 'Offer a bed to someone who is still waiting', { reason: 'entry_closed' })
  if (e.status === 'offered') {
    const existing = await pendingOfferOf(c.tx, e.staffId)
    if (existing && existing.bedId === i.bedId) {
      const d = await claimDates(c.tx, existing.claimId)
      return ok({ offerId: existing.id, entryId: e.id, bedId: existing.bedId, claimId: existing.claimId, from: d?.from ?? '', to: d?.to ?? null, created: false }, 'This bed is already offered to them')
    }
    return fail.conflict('This person already has a bed offer waiting for an answer', 'The offered resident', 'Withdraw that offer first, or wait for the answer', { reason: 'offer_pending', offerId: existing?.id })
  }
  if (e.expiresAt.getTime() <= c.now.getTime()) {
    return fail.conflict('This entry has passed its expiry date', 'Accommodation Admin', 'Renew the entry before offering, or add the person again', { reason: 'entry_expired' })
  }

  // The bed row is locked (entry -> offer -> bed): its state cannot change between this check and the hold that allocateBed makes.
  const [b] = await c.tx.select({ id: bed.id, siteId: bed.siteId, state: bed.state, tz: site.timeZone }).from(bed).innerJoin(site, eq(site.id, bed.siteId)).where(eq(bed.id, i.bedId)).limit(1).for('update', { of: bed })
  if (!b) return fail.notFound()
  const bedDenied = authorize(c, 'requests_waitlist.manage_offers', { siteId: b.siteId })
  if (bedDenied) return bedDenied
  const lbl = await bedLabel(c.tx, b.id)
  if (b.siteId !== e.siteId) return fail.conflict(`Bed ${lbl.code} is at a different site from this waitlist entry`, 'Accommodation Admin', 'Choose a bed at the site they are waiting for', { reason: 'wrong_site' })
  if (e.skipBedIds.includes(b.id)) {
    return fail.conflict(`This person already turned down, or did not answer, an offer of bed ${lbl.code}`, 'Accommodation Admin', 'Offer a different bed (D-50: a declined bed is skipped)', { reason: 'bed_skipped' })
  }
  const today = todayInZone(c.now, b.tz)
  const w = offerWindow(e, today)
  if (!w) return fail.conflict('The stay this person asked for is already over', 'Accommodation Admin', 'Renew the entry with new dates', { reason: 'window_over' })
  // P-13 (proposed, pending client sign-off, `readiness.offer_lead_days`): a bed that is not ready is not offered for a start inside the lead time.
  const notReady = await offerNotReady(c.tx, { id: b.id, code: lbl.code, state: b.state, siteId: b.siteId }, w.from, today)
  if (notReady) return notReady
  if (await alreadyHoused(c.tx, e.staffId)) return fail.conflict('This person already has a reservation or a bed', 'Accommodation Admin', 'Take them off the waitlist or cancel the reservation', { reason: 'already_housed' })

  // Queue discipline: the bed goes to the next eligible person unless an authorised admin overrides, with a reason.
  const head = await matchFreedBed(c.tx, b.id, c.now)
  const overridden = head !== undefined && head.entryId !== e.id
  if (overridden && !i.overrideReason) {
    return fail.conflict(`${await staffName(c.tx, head.staffId)} is ahead in the queue for this bed (position ${head.position})`, 'Accommodation Admin',
      'Offer it to them, or give a reason to override the queue order', { reason: 'ahead_in_queue', aheadEntryId: head.entryId, aheadPosition: head.position })
  }

  const other = await pendingOfferOf(c.tx, e.staffId)
  if (other) return fail.conflict('This person already has a bed offer waiting for an answer', 'The offered resident', 'Wait for the answer or withdraw that offer', { reason: 'offer_pending', offerId: other.id })

  const a = await allocateBed(c, { bedId: b.id, staffId: e.staffId, from: w.from, to: w.to, kind: 'offer_hold', requestId: e.requestId ?? undefined })
  if (!a.ok) return a

  const [o] = await c.tx.insert(bedOffer).values({ staffId: e.staffId, waitlistEntryId: e.id, bedId: b.id, claimId: a.data.claimId, createdBy: c.user.id, createdAt: c.now }).returning({ id: bedOffer.id })
  await c.tx.update(waitlistEntry).set({ status: 'offered' }).where(eq(waitlistEntry.id, e.id))
  await audit(c, {
    action: 'waitlist.offer.created', entityType: 'bed_offer', entityId: o.id, siteId: e.siteId, reason: overridden ? i.overrideReason : undefined,
    after: { entryId: e.id, staffId: e.staffId, bedId: b.id, bed: lbl.code, from: w.from, to: w.to ?? null, position: await queuePosition(c.tx, e.siteId, e.id), queueOverride: overridden ? { aheadEntryId: head!.entryId, aheadPosition: head!.position } : null },
  })
  await notify(c.tx, {
    dedupeKey: `offer:${o.id}:created`, kind: 'offer.created', to: { staffId: e.staffId },
    text: `A bed is being held for you: ${lbl.code} (${lbl.roomName}) from ${w.from}. Open My accommodation to see it. You have 48 hours from the moment you see it to accept or decline.`,
    ref: { type: 'bed_offer', id: o.id },
  })
  return ok({ offerId: o.id, entryId: e.id, bedId: b.id, claimId: a.data.claimId, from: w.from, to: w.to ?? null, created: true }, `Bed ${lbl.code} is held for ${await staffName(c.tx, e.staffId)}. The 48 hours start when they see the offer or you record that they were told`)
}

export const nextInput = z.object({ bedId: idSchema })

/** "Offer to the next in queue": finds the next eligible person for this bed and offers it (the button on a freed bed). */
export function offerToNext(rc: RequestContext, i: z.infer<typeof nextInput>): Promise<Result<OfferOut>> {
  return runCommand(rc, async c => {
    const [b] = await c.tx.select({ id: bed.id, siteId: bed.siteId }).from(bed).where(eq(bed.id, i.bedId)).limit(1)
    if (!b) return fail.notFound()
    const denied = authorize(c, 'requests_waitlist.manage_offers', { siteId: b.siteId })
    if (denied) return denied
    const next = await matchFreedBed(c.tx, b.id, c.now)
    if (!next) return fail.conflict('Nobody on the waitlist can take this bed right now', 'Accommodation Admin', 'Check the queue, the dates people asked for and their eligibility', { reason: 'nobody_next' })
    return createOfferIn(c, { entryId: next.entryId, bedId: b.id })
  })
}

export const withdrawInput = z.object({ offerId: idSchema, reason: reasonSchema })

/** Takes an offer back (dispute, bed needed, mistake). The hold is released and the person keeps their place in the queue. */
export function withdrawOffer(rc: RequestContext, i: z.infer<typeof withdrawInput>): Promise<Result> {
  return runCommand(rc, async c => {
    const locked = await loadOfferLocked(c.tx, i.offerId)
    if (!locked) return fail.notFound()
    const { offer, entry } = locked
    const lbl = await bedLabel(c.tx, offer.bedId)
    const denied = authorize(c, 'requests_waitlist.manage_offers', { siteId: lbl.siteId })
    if (denied) return denied
    if (offer.status === 'withdrawn') return done('Already withdrawn')
    if (offer.status !== 'pending') return fail.conflict(`This offer is already ${offer.status}`, 'Accommodation Admin', 'Nothing to withdraw', { reason: 'not_pending' })

    await endOffer(c.tx, offer, { status: 'withdrawn', note: i.reason, now: c.now })
    if (entry && entry.status === 'offered') await c.tx.update(waitlistEntry).set({ status: 'waiting' }).where(and(eq(waitlistEntry.id, entry.id), eq(waitlistEntry.status, 'offered')))
    await audit(c, { action: 'waitlist.offer.withdrawn', entityType: 'bed_offer', entityId: offer.id, siteId: lbl.siteId, reason: i.reason, before: { status: 'pending', bedId: offer.bedId }, after: { status: 'withdrawn', entryStatus: 'waiting', positionKept: true } })
    await notify(c.tx, {
      dedupeKey: `offer:${offer.id}:withdrawn`, kind: 'offer.withdrawn', to: { staffId: offer.staffId },
      text: `The bed offer for ${lbl.code} was withdrawn (${i.reason}). You keep your place on the waitlist.`, ref: { type: 'bed_offer', id: offer.id },
    })
    return done('Offer withdrawn; the hold is released')
  })
}
