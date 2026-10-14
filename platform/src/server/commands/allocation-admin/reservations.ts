/**
 * Reservation administration (AA): cancel a reservation and extend its no-show window once (D-58, docs/APPROVALS.md
 * "No-show extension / staff cancellation": AA with a reason). The no-show sweep that expires reservations is WP-F's
 * and reads eta + timers.no_show_hours x (1 + no_show_extended); nothing here is automatic.
 */
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { bed, reservation } from '@/server/db/schema'
import { audit } from '@/server/audit'
import { releaseClaim } from '@/server/allocation'
import { authorize, notSelf } from '@/server/command/authorize'
import { runCommand } from '@/server/command/run'
import type { CommandContext, RequestContext } from '@/server/command/context'
import { fail, failure, ok, type Failure, type Result } from '@/server/command/result'
import { getConfig } from '@/server/config/registry'
import { notify } from '@/server/notify'
import { fmtDate, HOUR } from '@/domain/time'
import { bedLabel, idSchema, reasonSchema } from '@/server/commands/requests/shared'

type ReservationRow = typeof reservation.$inferSelect

/** The reservation, visible and manageable by this actor, not their own, and locked. */
async function loadForAdmin(c: CommandContext, id: string, what: string): Promise<Failure | { rv: ReservationRow; siteId: string }> {
  const [peek] = await c.tx.select({ rv: reservation, siteId: bed.siteId }).from(reservation).innerJoin(bed, eq(bed.id, reservation.bedId)).where(eq(reservation.id, id))
  if (!peek) return fail.notFound()
  const denied = authorize(c, 'reservations_stays.manage', { siteId: peek.siteId, ownerStaffId: peek.rv.staffId })
  if (denied) return denied
  const self = notSelf(c, peek.rv.staffId, what)
  if (self) return self
  const [rv] = await c.tx.select().from(reservation).where(eq(reservation.id, id)).for('update')
  return { rv, siteId: peek.siteId }
}

const notReserved = (rv: ReservationRow): Failure => rv.status === 'checked_in'
  ? failure('conflict', 'The resident has already checked in, so this is no longer a reservation', { owner: 'Reception', next: 'Use the stay: transfer or check the resident out' })
  : failure('conflict', `This reservation is ${rv.status.replace(/_/g, ' ')} and can no longer be changed`, { owner: 'Accommodation Admin', next: 'File or approve a new request if the person still needs a bed' })

export const reservationActionInput = z.object({ reservationId: idSchema, reason: reasonSchema })
export type ReservationActionInput = z.infer<typeof reservationActionInput>

/** Cancels a reservation and releases its bed claim in the same transaction (the bed is free for those dates at once). */
export function cancelReservation(rc: RequestContext, i: ReservationActionInput): Promise<Result<{ reservationId: string; status: 'cancelled' }>> {
  return runCommand(rc, async c => {
    const l = await loadForAdmin(c, i.reservationId, 'cancel a reservation')
    if ('ok' in l) return l
    const { rv, siteId } = l
    if (rv.status === 'cancelled') {
      if (rv.cancelReason === i.reason) return ok({ reservationId: rv.id, status: 'cancelled' as const }, 'Already cancelled.') // a retried call
      return notReserved(rv)
    }
    if (rv.status !== 'reserved') return notReserved(rv)

    await releaseClaim(c.tx, rv.claimId, `Reservation cancelled: ${i.reason}`, c.now)
    await c.tx.update(reservation).set({ status: 'cancelled', cancelReason: i.reason }).where(eq(reservation.id, rv.id))
    const bl = await bedLabel(c.tx, rv.bedId)
    await audit(c, {
      action: 'requests.reservation.cancelled', entityType: 'reservation', entityId: rv.id, siteId, reason: i.reason,
      before: { status: 'reserved', bedId: rv.bedId, claimId: rv.claimId }, after: { status: 'cancelled', claimReleased: true },
    })
    await notify(c.tx, {
      dedupeKey: `reservation:${rv.id}:cancelled`, kind: 'reservation.cancelled', to: { staffId: rv.staffId }, ref: { type: 'reservation', id: rv.id },
      text: `Your reservation${bl ? ` (${bl.label})` : ''} was cancelled: ${i.reason}. Contact the Accommodation Admin or file a new request if you still need a bed.`,
    })
    return ok({ reservationId: rv.id, status: 'cancelled' as const }, 'Reservation cancelled and the bed is free again.')
  })
}

export interface ExtendOut { reservationId: string; noShowDeadline: string; extended: true }

/**
 * Extends the no-show deadline once, with a reason (D-58). The limit is timers.no_show_extensions; the reservation row only
 * has a yes/no flag, so one extension is the most it can record (more would need a counter column: reported).
 */
export function extendNoShow(rc: RequestContext, i: ReservationActionInput): Promise<Result<ExtendOut>> {
  return runCommand(rc, async c => {
    const l = await loadForAdmin(c, i.reservationId, 'extend a reservation')
    if ('ok' in l) return l
    const { rv, siteId } = l
    const hours = await getConfig(c.tx, 'timers.no_show_hours')
    const deadline = (extended: boolean) => new Date(rv.eta.getTime() + hours * HOUR * (extended ? 2 : 1)).toISOString()
    if (rv.status !== 'reserved') return notReserved(rv)
    const allowed = await getConfig(c.tx, 'timers.no_show_extensions')
    if (rv.noShowExtended) {
      return failure('conflict', 'The no-show deadline was already extended once, which is the most allowed', {
        owner: 'Policy Approver', next: 'Cancel the reservation if the person is not coming, or ask a Policy Approver to decide', detail: { reason: 'extension_limit', noShowDeadline: deadline(true) },
      })
    }
    if (allowed < 1) {
      return failure('conflict', 'No-show extensions are switched off in the configuration', { owner: 'Super Admin', next: 'Cancel the reservation, or ask a Super Admin to allow an extension', detail: { reason: 'extension_limit' } })
    }
    await c.tx.update(reservation).set({ noShowExtended: true }).where(eq(reservation.id, rv.id))
    await audit(c, { action: 'requests.reservation.no_show_extended', entityType: 'reservation', entityId: rv.id, siteId, reason: i.reason, before: { noShowDeadline: deadline(false) }, after: { noShowDeadline: deadline(true) } })
    await notify(c.tx, {
      dedupeKey: `reservation:${rv.id}:no_show_extended`, kind: 'reservation.extended', to: { staffId: rv.staffId }, ref: { type: 'reservation', id: rv.id },
      text: `Your arrival window was extended to ${fmtDate(deadline(true).slice(0, 10))}: ${i.reason}`,
    })
    return ok({ reservationId: rv.id, noShowDeadline: deadline(true), extended: true as const }, 'No-show deadline extended once.')
  })
}
