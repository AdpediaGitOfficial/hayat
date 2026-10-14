import { and, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { bed, reservation, stay } from '@/server/db/schema'
import { audit } from '@/server/audit'
import { authorize, notSelf } from '@/server/command/authorize'
import { runCommand } from '@/server/command/run'
import type { RequestContext } from '@/server/command/context'
import { fail, ok, type Result } from '@/server/command/result'
import { convertClaim } from '@/server/allocation'
import { checkEligibility, recordExceptionUse } from '@/server/eligibility'
import { notify } from '@/server/notify'
import { guardUnique } from '@/server/commands/property/shared'
import { readinessBlock } from './rules'
import { bedLabel, idSchema, lockBeds, OCCUPYING, reservationRow, siteToday } from './shared'

export const input = z.object({ reservationId: idSchema })
export type CheckInInput = z.infer<typeof input>
export interface CheckInOut { stayId: string; reservationId: string; bedId: string; bedLabel: string; from: string; to: string | null }

/**
 * Check-in (D-59, SRS 5.4): ONE transaction that revalidates the reservation, the person's eligibility and the bed's
 * readiness, then converts the reservation's claim into the stay's claim, inserts the stay and marks the bed occupied.
 * Any refusal rolls everything back. Readiness gates THIS step only (D-18): the reservation itself could be made on a bed
 * that was still being cleaned.
 *
 * Concurrency: the reservation row is locked first, so two simultaneous check-ins for one reservation queue up and the
 * second sees `checked_in` (it is told which stay exists, not an error page). The unique index on one active stay per
 * person is the last guard behind the explicit check.
 */
export function checkIn(rc: RequestContext, i: CheckInInput): Promise<Result<CheckInOut>> {
  return runCommand(rc, async c => {
    const r = await reservationRow(c.tx, i.reservationId, true)
    if (!r) return fail.notFound()
    const denied = authorize(c, 'checkin_checkout.execute', { siteId: r.siteId })
    if (denied) return denied
    const self = notSelf(c, r.staffId, 'check in')
    if (self) return self

    if (r.status === 'checked_in') {
      const [existing] = await c.tx.select({ id: stay.id }).from(stay).where(eq(stay.reservationId, r.id)).limit(1)
      return fail.conflict('This reservation is already checked in', 'Reception', 'Open the stay instead; nothing more to do', { reason: 'already_checked_in', stayId: existing?.id })
    }
    if (r.status !== 'reserved') {
      return fail.conflict(`This reservation is ${r.status.replace('_', ' ')}, so it cannot be checked in`, 'Accommodation Admin', 'Ask the Accommodation Admin for a new reservation, or use emergency check-in if the person is here now', { reason: 'reservation_closed', status: r.status })
    }

    const today = await siteToday(c.tx, r.siteId, c.now)
    if (r.from > today) {
      return fail.conflict(`This reservation starts on ${r.from}; check-in opens that day`, 'Reception', 'Check in on or after the arrival date, or ask the Accommodation Admin to change the reservation dates', { reason: 'too_early', arrival: r.from, today })
    }

    // One active stay per person: say which one, instead of a database error.
    const [already] = await c.tx.select({ id: stay.id, bedId: stay.bedId, status: stay.status }).from(stay)
      .where(and(eq(stay.staffId, r.staffId), inArray(stay.status, [...OCCUPYING]))).limit(1)
    if (already) return alreadyHasStay(c.tx, already)

    const [b] = await lockBeds(c.tx, [r.bedId])
    if (!b) return fail.notFound()
    const block = readinessBlock({ code: b.code, state: b.state, stateReason: b.stateReason })
    if (block) return fail.conflict(block.reason, block.owner, block.next, { reason: block.code, bedId: b.id, state: b.state })

    const e = await checkEligibility(c.tx, r.staffId, r.bedId, c.now, { requestId: r.requestId ?? undefined })
    if (!e) return fail.notFound()
    if (!e.ok) {
      return fail.conflict(e.reasons.join('; '), e.exceptionable ? 'Policy Approver' : 'Accommodation Admin',
        e.exceptionable ? 'Ask a Policy Approver for an exception, or ask the Accommodation Admin for an eligible bed' : 'Not eligible for accommodation',
        { reason: 'not_eligible', failed: e.failed, exceptionable: e.exceptionable })
    }

    await convertClaim(c.tx, r.claimId, 'stay')
    const created = await guardUnique(c.tx, q => q.insert(stay).values({
      staffId: r.staffId, bedId: r.bedId, claimId: r.claimId, reservationId: r.id, status: 'active', source: 'standard', stayType: r.stayType, checkedInAt: c.now,
    }).returning({ id: stay.id }))
    if (!created) {
      const [again] = await c.tx.select({ id: stay.id, bedId: stay.bedId, status: stay.status }).from(stay).where(and(eq(stay.staffId, r.staffId), inArray(stay.status, [...OCCUPYING]))).limit(1)
      return again ? alreadyHasStay(c.tx, again) : fail.conflict('This reservation was just checked in', 'Reception', 'Open the stay instead', { reason: 'already_checked_in' })
    }
    const stayId = created[0].id
    await c.tx.update(reservation).set({ status: 'checked_in' }).where(eq(reservation.id, r.id))
    await c.tx.update(bed).set({ state: 'occupied', stateReason: null, stateSince: c.now }).where(eq(bed.id, r.bedId))
    await recordExceptionUse(c.tx, e.exceptionIds, { for: 'stay', ref: stayId, by: c.user.id })

    const label = await bedLabel(c.tx, r.bedId)
    await audit(c, {
      action: 'stays.stay.checked_in', entityType: 'stay', entityId: stayId, siteId: r.siteId,
      before: { reservation: 'reserved', bed: b.state, claimKind: 'reservation' },
      after: { reservationId: r.id, reservation: 'checked_in', bed: 'occupied', claimKind: 'stay', bedId: r.bedId, from: r.from, to: r.to, staffId: r.staffId, keys: 'issue is recorded in Stage 3' },
    })
    await notify(c.tx, {
      dedupeKey: `stay:${stayId}:checked_in`, kind: 'stay.checked_in', to: { staffId: r.staffId }, ref: { type: 'stay', id: stayId },
      text: `You are checked in to ${label}${r.to ? ` until ${r.to}` : ''}.`,
    })
    return ok({ stayId, reservationId: r.id, bedId: r.bedId, bedLabel: label, from: r.from, to: r.to }, `Checked in to ${label}.`)
  })
}

async function alreadyHasStay(tx: Parameters<typeof bedLabel>[0], existing: { id: string; bedId: string; status: string }) {
  return fail.conflict(`This person already has an active stay (${await bedLabel(tx, existing.bedId)})`, 'Accommodation Admin',
    'Check the existing stay out, or move the person with a transfer, before a second check-in', { reason: 'has_active_stay', stayId: existing.id, status: existing.status })
}

/* ---------------- bulk (D-60) ---------------- */

export const bulkInput = z.object({ reservationIds: z.array(idSchema).min(1, 'Choose at least one arrival').max(100, 'At most 100 arrivals at a time') })
export type BulkCheckInInput = z.infer<typeof bulkInput>
export type BulkRow =
  | { reservationId: string; outcome: 'checked_in' | 'already_checked_in'; stayId: string | undefined }
  | { reservationId: string; outcome: 'failed'; reason: string; owner?: string; next?: string; code: string; detail?: unknown }
export interface BulkCheckInOut { rows: BulkRow[]; checkedIn: number; alreadyDone: number; failed: number }

/**
 * Batch arrivals: every row is its OWN transaction through the same path as a single check-in, so one blocked bed never
 * holds up the others, and the result says what happened per row. Retry-safe: running the same batch again reports the
 * rows already done as `already_checked_in` and tries the failed ones again.
 */
export async function bulkCheckIn(rc: RequestContext, i: BulkCheckInInput): Promise<Result<BulkCheckInOut>> {
  const rows: BulkRow[] = []
  for (const reservationId of new Set(i.reservationIds)) {
    const r = await checkIn(rc, { reservationId })
    if (r.ok) rows.push({ reservationId, outcome: 'checked_in', stayId: r.data.stayId })
    else if ((r.detail as { reason?: string } | undefined)?.reason === 'already_checked_in') rows.push({ reservationId, outcome: 'already_checked_in', stayId: (r.detail as { stayId?: string }).stayId })
    else rows.push({ reservationId, outcome: 'failed', reason: r.reason, owner: r.owner, next: r.next, code: r.code, detail: r.detail })
  }
  const checkedIn = rows.filter(r => r.outcome === 'checked_in').length
  const alreadyDone = rows.filter(r => r.outcome === 'already_checked_in').length
  const failed = rows.length - checkedIn - alreadyDone
  return ok({ rows, checkedIn, alreadyDone, failed }, `${checkedIn} checked in${alreadyDone ? `, ${alreadyDone} already done` : ''}${failed ? `, ${failed} need attention` : ''}.`)
}
