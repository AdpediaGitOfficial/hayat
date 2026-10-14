/**
 * Voluntary checkout (D-63): a resident who is still employed asks to leave on a date; Reception acknowledges it (within
 * 1 business day, the sweep reminds) and processes it. No approval. Processing is ONE transaction: the stay becomes
 * `checked_out`, its claim is released with a reason, the bed goes to Needs cleaning (a legal transition), the resident is
 * told. The resident keeps login and history (D-39).
 *
 * Checkout is not clearance and not bed ready (D-64): nothing here touches keys, cleaning, inspection or the clearance case.
 * The bed becomes Available only after Stage 3's cleaning and final inspection.
 */
import { and, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { bed, stay } from '@/server/db/schema'
import { checkoutRequest } from '@/server/db/schema.stays'
import { audit } from '@/server/audit'
import { authorize, notSelf } from '@/server/command/authorize'
import { runCommand } from '@/server/command/run'
import type { RequestContext } from '@/server/command/context'
import { fail, ok, type Result } from '@/server/command/result'
import { releaseClaim } from '@/server/allocation'
import { notify } from '@/server/notify'
import { guardUnique } from '@/server/commands/property/shared'
import { dateSchema, idSchema, KEYS_PLACEHOLDER, loadStayLocked, lockBeds, noteSchema, siteToday, staffName } from './shared'
import { openCleaningTask } from '@/server/readiness/hooks'
import { closeStayIfDone } from '@/server/stays-close'

/* ---------------- the resident's request ---------------- */

export const requestInput = z.object({ stayId: idSchema, departureDate: dateSchema, note: noteSchema })
export type RequestCheckoutInput = z.infer<typeof requestInput>

export function requestCheckout(rc: RequestContext, i: RequestCheckoutInput): Promise<Result<{ id: string; status: 'requested' }>> {
  return runCommand(rc, async c => {
    const s = await loadStayLocked(c.tx, i.stayId)
    if (!s) return fail.notFound()
    const denied = authorize(c, 'reservations_stays.request_checkout', { siteId: s.siteId, ownerStaffId: s.staffId })
    if (denied) return denied
    if (s.status !== 'active') return fail.conflict(`The stay is ${s.status.replace('_', ' ')}, so a checkout cannot be requested`, 'Reception', 'Nothing to do; ask Reception if you are unsure')
    const today = await siteToday(c.tx, s.siteId, c.now)
    if (i.departureDate < today) return fail.invalid('The departure date is in the past', { departureDate: `Choose ${today} or later` })
    if (s.to !== null && i.departureDate > s.to) {
      return fail.invalid(`The departure date is after your planned end (${s.to})`, { departureDate: `Choose ${s.to} or earlier, or ask for an extension` })
    }
    const created = await guardUnique(c.tx, q => q.insert(checkoutRequest).values({
      siteId: s.siteId, stayId: s.id, staffId: s.staffId, requestedBy: c.user.id, departureDate: i.departureDate, note: i.note, status: 'requested', createdAt: c.now,
    }).returning({ id: checkoutRequest.id }))
    if (!created) return fail.conflict('You already have a checkout request for this stay', 'Reception', 'Reception will contact you to arrange it', { reason: 'open_checkout' })
    const id = created[0].id
    const who = await staffName(c.tx, s.staffId)
    await audit(c, { action: 'stays.checkout.requested', entityType: 'checkout_request', entityId: id, siteId: s.siteId, reason: i.note ?? undefined, after: { stayId: s.id, departureDate: i.departureDate } })
    await notify(c.tx, { dedupeKey: `checkout:${id}:requested`, kind: 'checkout.requested', to: { role: 'Rec', siteId: s.siteId }, ref: { type: 'checkout_request', id }, text: `${who} plans to check out on ${i.departureDate}. Please acknowledge within 1 business day.` })
    return ok({ id, status: 'requested' as const }, `Checkout requested for ${i.departureDate}. Reception will confirm with you.`)
  })
}

/* ---------------- Reception acknowledges ---------------- */

export const ackInput = z.object({ id: idSchema })
export type AcknowledgeCheckoutInput = z.infer<typeof ackInput>

export function acknowledgeCheckout(rc: RequestContext, i: AcknowledgeCheckoutInput): Promise<Result<{ id: string; status: 'acknowledged' }>> {
  return runCommand(rc, async c => {
    const [r] = await c.tx.select().from(checkoutRequest).where(eq(checkoutRequest.id, i.id)).limit(1).for('update')
    if (!r) return fail.notFound()
    const denied = authorize(c, 'checkin_checkout.execute', { siteId: r.siteId })
    if (denied) return denied
    const self = notSelf(c, r.staffId, 'acknowledge a checkout')
    if (self) return self
    if (r.status === 'acknowledged') return ok({ id: r.id, status: 'acknowledged' as const }, 'Already acknowledged.')
    if (r.status !== 'requested') return fail.conflict(`This checkout request is ${r.status}`, 'Reception', 'Nothing more to do')
    await c.tx.update(checkoutRequest).set({ status: 'acknowledged', acknowledgedBy: c.user.id, acknowledgedAt: c.now }).where(eq(checkoutRequest.id, r.id))
    await audit(c, { action: 'stays.checkout.acknowledged', entityType: 'checkout_request', entityId: r.id, siteId: r.siteId, before: { status: 'requested' }, after: { status: 'acknowledged' } })
    await notify(c.tx, { dedupeKey: `checkout:${r.id}:acknowledged`, kind: 'checkout.acknowledged', to: { staffId: r.staffId }, ref: { type: 'checkout_request', id: r.id }, text: `Reception has noted your checkout on ${r.departureDate}.` })
    return ok({ id: r.id, status: 'acknowledged' as const }, 'Checkout acknowledged.')
  })
}

/* ---------------- Reception processes (the actual checkout) ---------------- */

export const processInput = z.object({ stayId: idSchema, note: noteSchema })
export type ProcessCheckoutInput = z.infer<typeof processInput>
export interface ProcessCheckoutOut { stayId: string; bedId: string; bedState: 'needs_cleaning'; checkoutRequestId: string | null }

/**
 * Checks the resident out. Works with or without a resident's request (a walk-up departure, or an overdue resident who has
 * finally left): the physical departure is what Reception records, so this is also the only way an overdue stay ends.
 * A sweep never calls this.
 */
export function processCheckout(rc: RequestContext, i: ProcessCheckoutInput): Promise<Result<ProcessCheckoutOut>> {
  return runCommand(rc, async c => {
    const s = await loadStayLocked(c.tx, i.stayId)
    if (!s) return fail.notFound()
    const denied = authorize(c, 'checkin_checkout.execute', { siteId: s.siteId })
    if (denied) return denied
    const self = notSelf(c, s.staffId, 'check out')
    if (self) return self
    if (s.status !== 'active') {
      return fail.conflict(s.status === 'checked_out' || s.status === 'closed' ? 'This stay is already checked out' : `The stay is ${s.status.replace('_', ' ')}`, 'Reception',
        s.status === 'checked_out' || s.status === 'closed' ? 'Nothing more to do' : 'An emergency stay is resolved by its approver first', { reason: s.status === 'checked_out' ? 'already_checked_out' : 'not_active', status: s.status })
    }
    const [b] = await lockBeds(c.tx, [s.bedId])
    const [req] = await c.tx.select().from(checkoutRequest).where(and(eq(checkoutRequest.stayId, s.id), inArray(checkoutRequest.status, ['requested', 'acknowledged']))).limit(1).for('update')

    const released = await releaseClaim(c.tx, s.claimId, 'checked_out', c.now)
    if (!released) return fail.conflict('The stay’s bed claim was already released', 'Accommodation Admin', 'Contact support: the stay and its claim disagree', { reason: 'claim_released' })
    await c.tx.update(stay).set({ status: 'checked_out', checkedOutAt: c.now }).where(eq(stay.id, s.id))
    const bedWas = b?.state
    if (b && b.state === 'occupied') await c.tx.update(bed).set({ state: 'needs_cleaning', stateReason: 'Resident checked out', stateSince: c.now }).where(eq(bed.id, b.id))
    if (bedWas === 'occupied') await openCleaningTask(c.tx, { bedId: s.bedId, reason: 'Resident checked out', now: c.now })
    await closeStayIfDone(c.tx, s.id, c.now) // closes only if nothing is outstanding (keys, clearance): checkout is not clearance
    if (req) await c.tx.update(checkoutRequest).set({ status: 'completed', completedBy: c.user.id, completedAt: c.now, acknowledgedAt: req.acknowledgedAt ?? c.now, acknowledgedBy: req.acknowledgedBy ?? c.user.id }).where(eq(checkoutRequest.id, req.id))

    await audit(c, {
      action: 'stays.stay.checked_out', entityType: 'stay', entityId: s.id, siteId: s.siteId, reason: i.note ?? undefined,
      before: { status: 'active', bed: bedWas, claim: 'live' },
      after: { status: 'checked_out', bed: 'needs_cleaning', claim: 'released', checkoutRequestId: req?.id ?? null, plannedEnd: s.to, ...KEYS_PLACEHOLDER, clearance: 'not started: Stage 3' },
    })
    await notify(c.tx, {
      dedupeKey: `stay:${s.id}:checked_out`, kind: 'stay.checked_out', to: { staffId: s.staffId }, ref: { type: 'stay', id: s.id },
      text: 'Your checkout is recorded. Thank you for staying with us. You keep your login and your history.',
    })
    return ok({ stayId: s.id, bedId: s.bedId, bedState: 'needs_cleaning' as const, checkoutRequestId: req?.id ?? null }, 'Checked out. The bed now needs cleaning and the final inspection before it is available again.')
  })
}
