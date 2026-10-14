/**
 * Building blocks for the waitlist and bed-offer commands (WP-E): row loaders that take the right lock, the
 * "end an offer" and "close an entry" steps that every path shares (decline, expiry, withdraw, leave, Mark as Left),
 * and the eligibility-in-principle check used when someone joins or renews.
 *
 * LOCK ORDER, everywhere (commands and sweeps): entry -> offer -> bed. allocateBed() locks the bed last, so a command and
 * a sweep that meet on the same offer cannot deadlock.
 */
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { z } from 'zod'
import { bed, accommodationRequest, bedClaim, room, staffProfile } from '@/server/db/schema'
import { bedOffer, waitlistEntry, waitlistPriorityRequest } from '@/server/db/schema.waitlist'
import type { Tx } from '@/server/command/context'
import { releaseClaim } from '@/server/allocation'
import { checkEligibility } from '@/server/eligibility'

export type EntryRow = typeof waitlistEntry.$inferSelect
export type OfferRow = typeof bedOffer.$inferSelect

export const idSchema = z.uuid('Not a valid identifier')
export const reasonSchema = z.string().trim().min(3, 'Give a reason (at least 3 characters)').max(500, 'At most 500 characters')
export const noteSchema = z.string().trim().min(3, 'Say how and when (at least 3 characters)').max(500, 'At most 500 characters')
export const dateSchema = z.iso.date('Use a date like 2026-11-30')

/** Entry statuses in which the person still waits for a bed (one such entry per person: database index). */
export const LIVE = ['waiting', 'offered'] as const

/**
 * OPEN (no decision yet): the time of day a reservation made by accepting an offer is expected to arrive.
 * Noon UTC on the arrival day, like the other reservation sources, until Grand Hyatt names a check-in time.
 */
export const OFFER_ETA_HOUR_UTC = 12

export const etaFor = (arrival: string): Date => new Date(`${arrival}T${String(OFFER_ETA_HOUR_UTC).padStart(2, '0')}:00:00Z`)

export const isoDay = (d: Date) => d.toISOString().slice(0, 10)
export const maxDay = (a: string, b: string) => (a >= b ? a : b)

/* ---------------- loaders (lock order: entry, offer) ---------------- */

export async function loadEntry(tx: Tx, id: string, lock = false): Promise<EntryRow | undefined> {
  const q = tx.select().from(waitlistEntry).where(eq(waitlistEntry.id, id)).limit(1)
  const [row] = lock ? await q.for('update') : await q
  return row
}

/** The offer and its entry, both locked, entry first. Undefined when the offer does not exist. */
export async function loadOfferLocked(tx: Tx, offerId: string): Promise<{ offer: OfferRow; entry?: EntryRow } | undefined> {
  const [peek] = await tx.select({ entryId: bedOffer.waitlistEntryId }).from(bedOffer).where(eq(bedOffer.id, offerId)).limit(1)
  if (!peek) return undefined
  const entry = peek.entryId ? await loadEntry(tx, peek.entryId, true) : undefined
  const [offer] = await tx.select().from(bedOffer).where(eq(bedOffer.id, offerId)).limit(1).for('update')
  return offer ? { offer, entry } : undefined
}

export async function pendingOfferOf(tx: Tx, staffId: string): Promise<OfferRow | undefined> {
  const [row] = await tx.select().from(bedOffer).where(and(eq(bedOffer.staffId, staffId), eq(bedOffer.status, 'pending'))).limit(1)
  return row
}

export async function staffName(tx: Pick<Tx, 'select'>, staffId: string): Promise<string> {
  const [r] = await tx.select({ n: staffProfile.fullName }).from(staffProfile).where(eq(staffProfile.id, staffId)).limit(1)
  return r?.n ?? 'Unknown'
}

export async function bedLabel(tx: Pick<Tx, 'select'>, bedId: string): Promise<{ code: string; roomName: string; siteId: string }> {
  const [r] = await tx.select({ code: bed.code, roomName: room.name, siteId: bed.siteId }).from(bed).innerJoin(room, eq(room.id, bed.roomId)).where(eq(bed.id, bedId)).limit(1)
  return r ?? { code: '?', roomName: '?', siteId: '' }
}

/** The dates a held bed covers: the person's wished arrival, but never a day that has already passed. */
export function offerWindow(entry: Pick<EntryRow, 'arrivalDate' | 'endDate'>, today: string): { from: string; to?: string } | undefined {
  const from = maxDay(entry.arrivalDate, today)
  if (entry.endDate && entry.endDate <= from) return undefined // the stay they asked for is already over
  return { from, to: entry.endDate ?? undefined }
}

/** The dates of a live claim, as 'YYYY-MM-DD' (arrival, departure or null for open-ended). */
export async function claimDates(tx: Pick<Tx, 'select'>, claimId: string): Promise<{ from: string; to: string | null } | undefined> {
  const [r] = await tx.select({ from: sql<string>`lower(${bedClaim.period})::text`, to: sql<string | null>`upper(${bedClaim.period})::text` }).from(bedClaim).where(eq(bedClaim.id, claimId)).limit(1)
  return r
}

/* ---------------- ending an offer, closing an entry ---------------- */

export type OfferEnd = 'declined' | 'expired' | 'withdrawn'

/**
 * Ends a pending offer and releases its hold. The caller has the entry and the offer locked and has checked the
 * offer is still pending. Does NOT touch the entry (the caller decides what the entry becomes).
 */
export async function endOffer(tx: Tx, offer: OfferRow, o: { status: OfferEnd; note: string; now: Date; respondedAt?: boolean }): Promise<void> {
  await tx.update(bedOffer).set({
    status: o.status, responseNote: o.note, ...(o.respondedAt ? { respondedAt: o.now } : {}),
  }).where(and(eq(bedOffer.id, offer.id), eq(bedOffer.status, 'pending')))
  await releaseClaim(tx, offer.claimId, `offer_${o.status}`, o.now)
}

/**
 * Closes a LIVE entry (caller holds the row lock): releases a pending offer, withdraws a pending priority request, and
 * moves the linked request on (waitlisted -> closed or cancelled). Returns what it released, for notifications and audit.
 */
export async function closeEntry(tx: Tx, entry: EntryRow, o: { reason: string; now: Date; offerNote: string; requestStatus: 'closed' | 'cancelled'; requestNote: string }): Promise<{ offer?: OfferRow }> {
  let released: OfferRow | undefined
  if (entry.status === 'offered') {
    const [offer] = await tx.select().from(bedOffer).where(and(eq(bedOffer.waitlistEntryId, entry.id), eq(bedOffer.status, 'pending'))).limit(1).for('update')
    if (offer) {
      await endOffer(tx, offer, { status: o.reason === 'expired' ? 'expired' : 'withdrawn', note: o.offerNote, now: o.now })
      released = offer
    }
  }
  await tx.update(waitlistPriorityRequest).set({ status: 'withdrawn' }).where(and(eq(waitlistPriorityRequest.entryId, entry.id), eq(waitlistPriorityRequest.status, 'pending')))
  await tx.update(waitlistEntry).set({ status: 'closed', closeReason: o.reason, closedAt: o.now }).where(eq(waitlistEntry.id, entry.id))
  if (entry.requestId) {
    await tx.update(accommodationRequest).set({ status: o.requestStatus, decisionReason: o.requestNote })
      .where(and(eq(accommodationRequest.id, entry.requestId), eq(accommodationRequest.status, 'waitlisted')))
  }
  return { offer: released }
}

/* ---------------- eligibility in principle ---------------- */

export interface InPrinciple { ok: boolean; reasons: string[]; exceptionable: boolean; noBeds: boolean }

/**
 * "Is this person eligible for at least one kind of bed at this site?" Uses the same eligibility rules as allocation, on one
 * bed per room (the rules depend on the room and the site, not on the bed). No rules are invented here: whatever
 * checkEligibility says is the answer, and a site with no beds says so.
 */
export async function eligibleInPrinciple(tx: Tx, staffId: string, siteId: string, now: Date, requestId?: string): Promise<InPrinciple> {
  const beds = await tx.selectDistinctOn([bed.roomId], { id: bed.id }).from(bed).innerJoin(room, eq(room.id, bed.roomId))
    .where(and(eq(bed.siteId, siteId), isNull(bed.archivedAt), isNull(room.archivedAt), inArray(bed.state, ['available', 'occupied', 'needs_cleaning', 'inspection_required', 'blocked', 'under_maintenance'])))
    .orderBy(asc(bed.roomId), asc(bed.code)).limit(80)
  if (beds.length === 0) return { ok: false, reasons: ['This site has no beds yet'], exceptionable: false, noBeds: true }
  let first: { reasons: string[]; exceptionable: boolean } | undefined
  for (const b of beds) {
    const e = await checkEligibility(tx, staffId, b.id, now, { requestId })
    if (!e) continue
    if (e.ok) return { ok: true, reasons: [], exceptionable: false, noBeds: false }
    first ??= { reasons: e.reasons, exceptionable: e.exceptionable }
  }
  return { ok: false, reasons: first?.reasons ?? ['No bed type at this site is open to this person'], exceptionable: first?.exceptionable ?? false, noBeds: false }
}
