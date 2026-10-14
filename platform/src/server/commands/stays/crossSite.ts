/**
 * What has to happen to everything ELSE that belongs to a person (or to their stay) when a transfer or swap moves them to ANOTHER
 * site (D-104, SRS 5.5 step 27: "cross-site transfers additionally revalidate site scope and cancel/review incompatible future
 * bookings or passes").
 *
 * The move itself (executeTransfer) is one atomic transaction; these follow-ups run INSIDE it, after the move, so a failure in any of
 * them rolls the whole move back and the resident stays where they were. Each follow-up is registered under an id and returns what it
 * did, which is written into the audit row of the move.
 *
 * EXTENSION POINT: `registerCrossSiteFollowUp(id, fn)`. Stage 4 registers the visitor-pass and contractor-pass follow-ups here
 * (cancel or hand to review the passes issued for the old site); nothing in the move needs to change for that.
 *
 * Built in:
 *  - `stay_requests`: an open extension or checkout request of the moved stay belongs to the site the bed is in now, so it is handed to
 *    that site's Accommodation Admin / Reception (its `site_id` changes) and a stale "next booking clashes" note on an extension is
 *    dropped (approving it re-checks the new bed anyway).
 *  - `future_bookings`: a person with a live stay cannot also hold a future reservation, a waitlist entry or a pending bed offer. None
 *    can exist today (a request is refused while the person has a bed), so this is a guard: should one exist it is cancelled,
 *    closed or withdrawn with the reason "moved to <site>", the person and the site that held it are told, and it is audited. The
 *    hold on a bed is released in the same step, so nothing is left dangling.
 */
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { reservation } from '@/server/db/schema'
import { checkoutRequest, extensionRequest } from '@/server/db/schema.stays'
import { audit } from '@/server/audit'
import type { CommandContext } from '@/server/command/context'
import { releaseClaim } from '@/server/allocation'
import { notify } from '@/server/notify'
import { closeEntriesForStaff, withdrawOffersForStaff } from '@/server/commands/waitlist/close'
import { bedLabel } from './shared'
import { siteNameOf } from './transferShared'

export interface CrossSiteMove {
  staffId: string
  stayId: string
  fromSiteId: string
  toSiteId: string
  transferId: string
}
export interface FollowUpOutcome {
  /** Short counts and notes for the audit row, for example `{ cancelled: 1 }`. */
  [key: string]: number | string | string[]
}
export type CrossSiteFollowUp = (c: CommandContext, m: CrossSiteMove) => Promise<FollowUpOutcome>

const FOLLOW_UPS = new Map<string, CrossSiteFollowUp>()

/** Registers a follow-up under a stable id (Stage 4: `visitor_passes`, `contractor_passes`). Registering the same id twice is a programming error. */
export function registerCrossSiteFollowUp(id: string, fn: CrossSiteFollowUp): void {
  if (FOLLOW_UPS.has(id) && FOLLOW_UPS.get(id) !== fn) throw new Error(`cross-site follow-up ${id} is registered twice`)
  FOLLOW_UPS.set(id, fn)
}
export const crossSiteFollowUpIds = (): string[] => [...FOLLOW_UPS.keys()]

/** Runs every registered follow-up in registration order, inside the caller's transaction. Returns what each one did. */
export async function runCrossSiteFollowUps(c: CommandContext, m: CrossSiteMove): Promise<Record<string, FollowUpOutcome>> {
  const out: Record<string, FollowUpOutcome> = {}
  for (const [id, fn] of FOLLOW_UPS) out[id] = await fn(c, m)
  return out
}

/* ---------------- built in: the stay's own open requests ---------------- */

registerCrossSiteFollowUp('stay_requests', async (c, m) => {
  const toName = await siteNameOf(c.tx, m.toSiteId)
  const exts = await c.tx.update(extensionRequest).set({ siteId: m.toSiteId, clash: null })
    .where(and(eq(extensionRequest.stayId, m.stayId), eq(extensionRequest.status, 'requested'))).returning({ id: extensionRequest.id })
  const outs = await c.tx.update(checkoutRequest).set({ siteId: m.toSiteId })
    .where(and(eq(checkoutRequest.stayId, m.stayId), inArray(checkoutRequest.status, ['requested', 'acknowledged']))).returning({ id: checkoutRequest.id })
  for (const e of exts) {
    await audit(c, { action: 'stays.extension.rerouted', entityType: 'extension_request', entityId: e.id, siteId: m.toSiteId, reason: `The resident moved to ${toName}`, before: { siteId: m.fromSiteId }, after: { siteId: m.toSiteId } })
    await notify(c.tx, { dedupeKey: `extension:${e.id}:rerouted:${m.transferId}`, kind: 'extension.rerouted', to: { role: 'AA', siteId: m.toSiteId }, ref: { type: 'extension_request', id: e.id }, text: `An extension request came with a resident who moved to ${toName}. It is yours to decide now.` })
  }
  for (const o of outs) {
    await audit(c, { action: 'stays.checkout_request.rerouted', entityType: 'checkout_request', entityId: o.id, siteId: m.toSiteId, reason: `The resident moved to ${toName}`, before: { siteId: m.fromSiteId }, after: { siteId: m.toSiteId } })
    await notify(c.tx, { dedupeKey: `checkout:${o.id}:rerouted:${m.transferId}`, kind: 'checkout.rerouted', to: { role: 'Rec', siteId: m.toSiteId }, ref: { type: 'checkout_request', id: o.id }, text: `A checkout request came with a resident who moved to ${toName}. Reception there handles it now.` })
  }
  return { extensionsRerouted: exts.length, checkoutsRerouted: outs.length }
})

/* ---------------- built in: future bookings that can no longer stand ---------------- */

registerCrossSiteFollowUp('future_bookings', async (c, m) => {
  const toName = await siteNameOf(c.tx, m.toSiteId)
  const why = `Moved to ${toName} by a transfer`
  const rows = await c.tx.select({ id: reservation.id, bedId: reservation.bedId, claimId: reservation.claimId })
    .from(reservation).where(and(eq(reservation.staffId, m.staffId), eq(reservation.status, 'reserved'), isNull(reservation.archivedAt))).for('update')
  for (const r of rows) {
    await releaseClaim(c.tx, r.claimId, `Reservation cancelled: ${why}`, c.now)
    await c.tx.update(reservation).set({ status: 'cancelled', cancelReason: why }).where(eq(reservation.id, r.id))
    const where = await bedLabel(c.tx, r.bedId)
    await audit(c, { action: 'stays.transfer.booking_cancelled', entityType: 'reservation', entityId: r.id, siteId: m.toSiteId, reason: why, before: { status: 'reserved', bedId: r.bedId }, after: { status: 'cancelled', claimReleased: true, transferId: m.transferId } })
    await notify(c.tx, { dedupeKey: `reservation:${r.id}:cancelled:${m.transferId}`, kind: 'reservation.cancelled', to: { staffId: m.staffId }, ref: { type: 'reservation', id: r.id }, text: `Your reservation (${where}) was cancelled because you moved to ${toName}. You cannot hold two beds.` })
  }
  const entries = await closeEntriesForStaff(c, m.staffId, why)
  const offers = await withdrawOffersForStaff(c, m.staffId, why)
  return { reservationsCancelled: rows.length, waitlistEntriesClosed: entries, offersWithdrawn: offers }
})
