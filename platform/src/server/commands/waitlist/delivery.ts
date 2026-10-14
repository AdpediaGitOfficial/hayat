/**
 * Offer delivery (D-49, D-51). The 48-hour window starts only when delivery is CONFIRMED:
 *  - viewed: the resident opened the offer in the app (first read; viewOffer),
 *  - email: the email was confirmed delivered (Stage 5 calls markOfferEmailDelivered; confirmDelivery is the manual path),
 *  - offline: Reception or the Accommodation Admin told the resident in person or by phone and recorded how and when.
 * Creating the offer (and the in-app notification) is NOT delivery. Until delivery is confirmed the offer cannot expire;
 * after 24 hours without it Reception is alerted (waitlist sweep).
 */
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { audit } from '@/server/audit'
import { authorize, notSelf } from '@/server/command/authorize'
import { runCommand } from '@/server/command/run'
import type { RequestContext, Tx } from '@/server/command/context'
import { fail, ok, type Result } from '@/server/command/result'
import { HOUR } from '@/domain/time'
import { getConfig } from '@/server/config/registry'
import { notify } from '@/server/notify'
import { decide } from '@/server/policy'
import { bedOffer } from '@/server/db/schema.waitlist'
import { queuePosition } from './queue'
import { bedLabel, claimDates, idSchema, loadOfferLocked, noteSchema, type EntryRow, type OfferRow } from './shared'
import { site } from '@/server/db/schema'

export interface OfferView {
  id: string
  status: OfferRow['status']
  staffId: string
  bed: { id: string; code: string; roomName: string; siteId: string; siteName: string }
  from: string
  to: string | null
  deliveredAt: string | null
  deliveredVia: OfferRow['deliveredVia']
  expiresAt: string | null
  acceptedOnBehalf: boolean
  entryId: string | null
  declines: number
  position: number | null
  /** The resident may answer now: pending, and the window has not passed. */
  canRespond: boolean
}

async function describe(tx: Tx, offer: OfferRow, entry: EntryRow | undefined, now: Date): Promise<OfferView> {
  const lbl = await bedLabel(tx, offer.bedId)
  const [s] = await tx.select({ name: site.name }).from(site).where(eq(site.id, lbl.siteId)).limit(1)
  const d = await claimDates(tx, offer.claimId)
  return {
    id: offer.id, status: offer.status, staffId: offer.staffId,
    bed: { id: offer.bedId, code: lbl.code, roomName: lbl.roomName, siteId: lbl.siteId, siteName: s?.name ?? '' },
    from: d?.from ?? '', to: d?.to ?? null,
    deliveredAt: offer.deliveredAt?.toISOString() ?? null, deliveredVia: offer.deliveredVia, expiresAt: offer.expiresAt?.toISOString() ?? null,
    acceptedOnBehalf: offer.acceptedOnBehalf, entryId: entry?.id ?? null, declines: entry?.declines ?? 0,
    position: entry && entry.status !== 'closed' ? await queuePosition(tx, entry.siteId, entry.id) ?? null : null,
    canRespond: offer.status === 'pending' && (!offer.expiresAt || offer.expiresAt.getTime() > now.getTime()),
  }
}

/** Starts the clock. The caller holds the offer and entry locks and has checked the offer is pending and undelivered. */
async function applyDelivery(tx: Tx, offer: OfferRow, o: { via: 'viewed' | 'email' | 'offline'; now: Date; by?: string; note?: string }): Promise<Date> {
  const expiresAt = new Date(o.now.getTime() + (await getConfig(tx, 'timers.offer_hours')) * HOUR)
  await tx.update(bedOffer).set({ deliveredAt: o.now, deliveredVia: o.via, deliveredBy: o.by ?? null, deliveryNote: o.note ?? null, expiresAt }).where(eq(bedOffer.id, offer.id))
  await notify(tx, {
    dedupeKey: `offer:${offer.id}:delivered`, kind: 'offer.delivered', to: { staffId: offer.staffId },
    text: `Your bed offer is open until ${expiresAt.toISOString().slice(0, 16).replace('T', ' ')} UTC. Accept it or decline it in My accommodation. The first decline keeps your place; a second one moves you to the back of the queue.`,
    ref: { type: 'bed_offer', id: offer.id },
  })
  return expiresAt
}

/**
 * Reads an offer. When the offered resident themselves opens it, that is confirmed delivery (first read only): the 48 hours
 * start now. Anyone else with access (Reception, the Accommodation Admin, auditors) can read it without starting anything.
 */
export function viewOffer(rc: RequestContext, i: { offerId: string }): Promise<Result<OfferView>> {
  return runCommand(rc, async c => {
    let l = await loadOfferLocked(c.tx, i.offerId)
    if (!l) return fail.notFound()
    const lbl = await bedLabel(c.tx, l.offer.bedId)
    const denied = authorize(c, 'requests_waitlist.view', { siteId: lbl.siteId, ownerStaffId: l.offer.staffId })
    if (denied) return denied
    const isTheResident = c.actor.role === 'Res' && c.actor.staffId === l.offer.staffId
    if (isTheResident && l.offer.status === 'pending' && !l.offer.deliveredAt) {
      const expiresAt = await applyDelivery(c.tx, l.offer, { via: 'viewed', now: c.now })
      await audit(c, { action: 'waitlist.offer.delivered', entityType: 'bed_offer', entityId: l.offer.id, siteId: lbl.siteId, after: { via: 'viewed', deliveredAt: c.now.toISOString(), expiresAt: expiresAt.toISOString() } })
      l = await loadOfferLocked(c.tx, i.offerId)
      if (!l) return fail.notFound()
    }
    return ok(await describe(c.tx, l.offer, l.entry, c.now))
  })
}

export const deliveryInput = z.object({
  offerId: idSchema,
  via: z.enum(['email', 'offline']),
  /** Offline: how and when the resident was told ("phoned at 14:10, said they will answer tonight"). */
  note: noteSchema.optional(),
})

/**
 * Records confirmed delivery by email (placeholder: Stage 5 confirms real deliveries with markOfferEmailDelivered) or
 * "informed offline" by staff, with a note (D-51). Never the offered person for themselves. Repeating it changes nothing:
 * the window started at the first confirmation and is not restarted.
 */
export function confirmDelivery(rc: RequestContext, i: z.infer<typeof deliveryInput>): Promise<Result<OfferView>> {
  return runCommand(rc, async c => {
    const l = await loadOfferLocked(c.tx, i.offerId)
    if (!l) return fail.notFound()
    const lbl = await bedLabel(c.tx, l.offer.bedId)
    const res = { siteId: lbl.siteId }
    const may = i.via === 'offline'
      ? decide(c.actor, 'requests_waitlist.record_offline_offer', res).allowed || decide(c.actor, 'requests_waitlist.manage_offers', res).allowed
      : decide(c.actor, 'requests_waitlist.manage_offers', res).allowed
    if (!may) return authorize(c, i.via === 'offline' ? 'requests_waitlist.record_offline_offer' : 'requests_waitlist.manage_offers', res)!
    const sod = notSelf(c, l.offer.staffId, 'confirm delivery of your own offer')
    if (sod) return sod
    if (i.via === 'offline' && !i.note) return fail.invalid('Say how and when the resident was told', { note: 'Required for "informed offline"' })

    if (l.offer.status !== 'pending') return fail.conflict(`This offer is already ${l.offer.status}`, 'Accommodation Admin', 'Nothing to confirm', { reason: 'not_pending' })
    if (!l.offer.deliveredAt) {
      const expiresAt = await applyDelivery(c.tx, l.offer, { via: i.via, now: c.now, by: c.user.id, note: i.note })
      await audit(c, { action: 'waitlist.offer.delivered', entityType: 'bed_offer', entityId: l.offer.id, siteId: lbl.siteId, reason: i.note, after: { via: i.via, deliveredAt: c.now.toISOString(), expiresAt: expiresAt.toISOString() } })
    }
    const fresh = await loadOfferLocked(c.tx, i.offerId)
    return ok(await describe(c.tx, fresh!.offer, fresh!.entry, c.now), l.offer.deliveredAt ? 'Delivery was already confirmed; the window is unchanged' : 'Delivery recorded; the 48 hours have started')
  })
}

/** For Stage 5's email delivery worker, inside its own system transaction. Returns true if this call started the window. */
export async function markOfferEmailDelivered(tx: Tx, offerId: string, now: Date): Promise<boolean> {
  const l = await loadOfferLocked(tx, offerId)
  if (!l || l.offer.status !== 'pending' || l.offer.deliveredAt) return false
  await applyDelivery(tx, l.offer, { via: 'email', now })
  return true
}
