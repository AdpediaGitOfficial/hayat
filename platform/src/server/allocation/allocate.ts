/**
 * allocateBed(): the single path by which a bed gets a claim for a person (approval, bulk allocation, offers,
 * transfer, swap, emergency check-in all call it). Inside the CALLER's transaction it
 *   1. locks the bed row (FOR UPDATE) so concurrent allocations queue up and the loser fails cleanly,
 *   2. refuses blocked, maintenance and archived beds, and (for check-in) beds that are not ready,
 *   3. checks eligibility and records any Policy Approver exception used,
 *   4. refuses a held bed (pending offer) and any overlapping live claim, naming the next suggested beds,
 *   5. inserts the claim.
 * Authorization (may this actor allocate here?) and separation of duties belong to the caller, before this.
 */
import { and, eq, isNull } from 'drizzle-orm'
import { bed, reservation, room, site } from '@/server/db/schema'
import type { CommandContext } from '@/server/command/context'
import { fail, ok, type Result } from '@/server/command/result'
import type { ClaimKind } from '@/domain/enums'
import { checkEligibility } from '@/server/eligibility'
import { getConfig } from '@/server/config/registry'
import { todayInZone } from '@/server/commands/property/shared'
import { addDays } from '@/domain/time'
import { insertClaim, overlappingClaims } from './claims'
import { suggestBeds } from './suggest'

export interface AllocateInput {
  bedId: string
  staffId: string
  from: string
  to?: string
  kind: ClaimKind
  /** Scopes exceptions that were granted for one request. */
  requestId?: string
  /** Scopes an exception granted for one transfer (P-10). */
  transferId?: string
  // No "ignore this claim" option on purpose: a caller that replaces its own claim (transfer, swap, extension) releases
  // it first in the same transaction, and accepting an offer converts the hold in place (convertClaim) instead of allocating.
  /** Check-in: the bed must be ready, not merely allocatable (D-18, D-59). */
  requireReady?: boolean
  /** Emergency check-in: eligibility is deferred to the approver (D-66). The caller records that. */
  skipEligibility?: boolean
  /** One open reservation per person unless the caller says otherwise (bulk and offers handle their own). */
  allowSecondReservation?: boolean
}
export interface Allocated { claimId: string; bedId: string; siteId: string; exceptionIds: string[] }

const UNAVAILABLE: Record<string, string> = { blocked: 'blocked', under_maintenance: 'under maintenance', archived: 'archived' }

export async function allocateBed(c: CommandContext, a: AllocateInput): Promise<Result<Allocated>> {
  const [b] = await c.tx.select({
    id: bed.id, code: bed.code, state: bed.state, stateReason: bed.stateReason, siteId: bed.siteId, archivedAt: bed.archivedAt,
    roomName: room.name, siteName: site.name, tz: site.timeZone,
  }).from(bed).innerJoin(room, eq(room.id, bed.roomId)).innerJoin(site, eq(site.id, bed.siteId))
    .where(eq(bed.id, a.bedId)).limit(1).for('update', { of: bed })
  if (!b) return fail.notFound()

  if (b.archivedAt || UNAVAILABLE[b.state]) {
    const what = b.archivedAt ? 'archived' : UNAVAILABLE[b.state]
    return fail.conflict(`Bed ${b.code} is ${what}${b.stateReason ? `: ${b.stateReason}` : ''}`, 'Maintenance Coordinator', 'Unblock the bed or choose another', { reason: 'bed_unavailable', bedId: b.id, state: b.state })
  }
  if (a.requireReady && b.state !== 'available') {
    return fail.conflict(`Bed ${b.code} is not ready (${b.state.replace(/_/g, ' ')})`, 'Housekeeping and final inspection', 'Finish cleaning and inspection, or move the resident to a ready bed', { reason: 'bed_not_ready', bedId: b.id, state: b.state })
  }

  // P-13 (proposed, pending client sign-off, `readiness.offer_lead_days`; AT-021, D-18, SPEC-AMENDMENTS C-6): a bed that is not ready can carry a
  // reservation for a LATER date, not one that starts inside the lead time. Offers apply the same rule in `createOffer`; check-in uses `requireReady`.
  if (a.kind === 'reservation' && (b.state === 'needs_cleaning' || b.state === 'inspection_required')) {
    const lead = await getConfig(c.tx, 'readiness.offer_lead_days')
    if (lead > 0) {
      const today = todayInZone(c.now, b.tz)
      const earliest = addDays(today, lead)
      if (a.from < earliest) {
        const waiting = b.state === 'needs_cleaning' ? ['Housekeeping', 'Assign and finish the cleaning and the final inspection, or reserve from ' + earliest] : ['Final Inspection holder', 'Complete the final inspection, or reserve from ' + earliest]
        return fail.conflict(
          `Bed ${b.code} is not ready (${b.state.replace(/_/g, ' ')}), so it cannot be reserved from ${a.from}. A bed that is not ready can be reserved from ${earliest}; proposed policy P-13, pending client sign-off`,
          waiting[0], waiting[1], { reason: 'bed_not_ready', bedId: b.id, state: b.state, from: a.from, earliest, leadDays: lead, proposal: 'P-13' })
      }
    }
  }

  let exceptionIds: string[] = []
  if (!a.skipEligibility) {
    const e = await checkEligibility(c.tx, a.staffId, a.bedId, c.now, { requestId: a.requestId, transferId: a.transferId })
    if (!e) return fail.notFound()
    if (!e.ok) {
      return fail.conflict(e.reasons.join('; '), e.exceptionable ? 'Policy Approver' : 'Accommodation Admin',
        e.exceptionable ? 'Ask a Policy Approver for an exception, or choose an eligible bed' : 'Not eligible for accommodation',
        { reason: 'not_eligible', failed: e.failed, exceptionable: e.exceptionable })
    }
    exceptionIds = e.exceptionIds
  }

  const conflicts = await overlappingClaims(c.tx, a.bedId, a.from, a.to)
  if (conflicts.length) {
    const held = conflicts.some(x => x.kind === 'offer_hold')
    const suggestions = await suggestBeds(c.tx, { staffId: a.staffId, siteId: b.siteId, from: a.from, to: a.to, limit: 3, excludeBedIds: [a.bedId], requestId: a.requestId, transferId: a.transferId, now: c.now })
    return fail.conflict(
      held ? `Bed ${b.code} is held by a bed offer` : `Bed ${b.code} is already taken for those dates`,
      held ? 'The offered resident' : 'Another admin',
      held ? 'Wait for the offer to be accepted, declined or to expire, or choose another bed' : suggestions.length ? 'Choose one of the suggested beds' : 'Choose different dates or join the waitlist',
      { reason: held ? 'bed_held' : 'bed_taken', bedId: b.id, conflicts: conflicts.map(x => ({ kind: x.kind, from: x.from, to: x.to })), suggestions })
  }

  if (a.kind === 'reservation' && !a.allowSecondReservation) {
    const [other] = await c.tx.select({ id: reservation.id }).from(reservation)
      .where(and(eq(reservation.staffId, a.staffId), eq(reservation.status, 'reserved'), isNull(reservation.archivedAt))).limit(1)
    if (other) return fail.conflict('This person already has a reservation', 'Accommodation Admin', 'Cancel or move the existing reservation first', { reason: 'has_reservation', reservationId: other.id })
  }

  const claimId = await insertClaim(c.tx, { bedId: a.bedId, kind: a.kind, from: a.from, to: a.to })
  return ok({ claimId, bedId: a.bedId, siteId: b.siteId, exceptionIds })
}
