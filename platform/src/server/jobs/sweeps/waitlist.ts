/**
 * Waitlist and bed-offer timers (D-47 to D-52). Three sweeps, each safe to run twice or from two instances at once
 * (state is re-checked under row locks, notifications carry event-based dedupe keys, one transaction per item):
 *
 *  waitlist_expiry          closes entries at expires_at (reason "expired"), releases any offer hold, notifies; reminds at 3 and 1 days.
 *  waitlist_offer_expiry    expires offers 48 h after CONFIRMED delivery with no answer, releases the hold, puts the entry back to
 *                           Waiting with its place kept, and tells the Accommodation Admin which bed is free and who is next.
 *  waitlist_offer_followup  24 h after creation with no confirmed delivery, asks Reception to inform the resident (once).
 *
 * What these never do: approve, reject, move or check anyone in or out, or create the next offer. Letting a lapse close an
 * entry or release a hold is what the rules say happens; choosing the next person to offer a bed is an admin's decision.
 */
import { and, eq, isNull, lte, ne } from 'drizzle-orm'
import { bedOffer, waitlistEntry } from '@/server/db/schema.waitlist'
import { auditSystem, registerSweep, systemTx, type SweepContext } from '@/server/jobs/registry'
import { DAY, HOUR } from '@/domain/time'
import { getConfig } from '@/server/config/registry'
import { notify } from '@/server/notify'
import { notifyFreedBed } from '@/server/commands/waitlist/queue'
import { bedLabel, closeEntry, endOffer, loadEntry, loadOfferLocked, staffName } from '@/server/commands/waitlist/shared'

/** One bad row never blocks the others: each item runs in its own transaction and a failure is logged and counted. */
async function each(ctx: SweepContext, ids: string[], out: Record<string, number>, fn: (id: string) => Promise<void>) {
  for (const id of ids) {
    try { await fn(id) } catch (e) {
      out.failed = (out.failed ?? 0) + 1
      console.error(JSON.stringify({ level: 'error', msg: 'waitlist sweep item failed', id, requestId: ctx.requestId, error: e instanceof Error ? e.message : String(e) }))
    }
  }
}
const ymd = (d: Date) => d.toISOString().slice(0, 10)

registerSweep({
  name: 'waitlist_expiry',
  description: 'Closes waitlist entries after 15 days (releasing any offer hold) and reminds the resident and the Accommodation Admin 3 and 1 days before. Never offers, approves or moves anyone.',
  async run(ctx) {
    const out: Record<string, number> = { expired: 0, offersReleased: 0, reminded: 0, failed: 0 }

    const due = await ctx.db.select({ id: waitlistEntry.id }).from(waitlistEntry).where(and(ne(waitlistEntry.status, 'closed'), lte(waitlistEntry.expiresAt, ctx.now)))
    await each(ctx, due.map(d => d.id), out, id => systemTx(ctx, async tx => {
      const e = await loadEntry(tx, id, true)
      if (!e || e.status === 'closed' || e.expiresAt.getTime() > ctx.now.getTime()) return
      const { offer } = await closeEntry(tx, e, {
        reason: 'expired', now: ctx.now, offerNote: 'Released: the waitlist entry expired', requestStatus: 'closed', requestNote: 'The waitlist entry expired without a bed',
      })
      await auditSystem(tx, ctx, {
        action: 'waitlist.entry.expired', entityType: 'waitlist_entry', entityId: e.id, siteId: e.siteId, reason: 'Waitlist entry reached its expiry date',
        before: { status: e.status, expiresAt: e.expiresAt.toISOString(), remindersSent: e.remindersSent }, after: { status: 'closed', closeReason: 'expired', remindersSent: e.remindersSent, offerReleased: offer?.id ?? null },
      })
      await notify(tx, {
        dedupeKey: `waitlist:${e.id}:expired`, kind: 'waitlist.expired', to: { staffId: e.staffId },
        text: `Your waitlist entry ended on ${ymd(e.expiresAt)} without a bed.${offer ? ' The bed that was held for you has been released.' : ''} Ask Reception or your Accommodation Admin if you still need accommodation.`,
        ref: { type: 'waitlist_entry', id: e.id },
      })
      await notify(tx, {
        dedupeKey: `waitlist:${e.id}:expired:admin`, kind: 'waitlist.expired', to: { role: 'AA', siteId: e.siteId },
        text: `${await staffName(tx, e.staffId)}'s waitlist entry expired without a bed.`, ref: { type: 'waitlist_entry', id: e.id },
      })
      if (offer) {
        out.offersReleased++
        await notify(tx, { dedupeKey: `offer:${offer.id}:expired:entry`, kind: 'offer.expired', to: { staffId: e.staffId }, text: 'Your bed offer ended because the waitlist entry expired.', ref: { type: 'bed_offer', id: offer.id } })
        await notifyFreedBed(tx, offer.bedId, ctx.now, `offer:${offer.id}:released`)
      }
      out.expired++
    }))

    // Reminders, once per configured day and renewal cycle (a renewed entry is reminded again for its new expiry).
    const days = [...(await getConfig(ctx.db, 'timers.waitlist_reminder_days'))].sort((a, b) => b - a)
    if (days.length) {
      const horizon = new Date(ctx.now.getTime() + days[0] * DAY)
      const soon = await ctx.db.select({ id: waitlistEntry.id }).from(waitlistEntry).where(and(ne(waitlistEntry.status, 'closed'), lte(waitlistEntry.expiresAt, horizon)))
      await each(ctx, soon.map(s => s.id), out, id => systemTx(ctx, async tx => {
        const e = await loadEntry(tx, id, true)
        if (!e || e.status === 'closed' || e.expiresAt.getTime() <= ctx.now.getTime()) return
        const reached = days.filter(d => ctx.now.getTime() >= e.expiresAt.getTime() - d * DAY && !e.remindersSent.includes(d))
        if (reached.length === 0) return
        // If the sweep was late and several reminder points have passed, send one reminder (the most urgent) and record them all.
        const left = Math.max(1, Math.ceil((e.expiresAt.getTime() - ctx.now.getTime()) / DAY))
        const mark = Math.min(...reached)
        await tx.update(waitlistEntry).set({ remindersSent: [...e.remindersSent, ...reached] }).where(eq(waitlistEntry.id, e.id))
        const cycle = `waitlist:${e.id}:c${e.renewals}:reminder:${mark}`
        await notify(tx, {
          dedupeKey: cycle, kind: 'waitlist.reminder', to: { staffId: e.staffId },
          text: `Your waitlist entry ends in ${left} day${left === 1 ? '' : 's'} (${ymd(e.expiresAt)}). Ask your Accommodation Admin to renew it if you still need a bed.`, ref: { type: 'waitlist_entry', id: e.id },
        })
        await notify(tx, {
          dedupeKey: `${cycle}:admin`, kind: 'waitlist.reminder', to: { role: 'AA', siteId: e.siteId },
          text: `${await staffName(tx, e.staffId)}'s waitlist entry ends in ${left} day${left === 1 ? '' : 's'}. Renew it to keep their place, or let it lapse.`, ref: { type: 'waitlist_entry', id: e.id },
        })
        await auditSystem(tx, ctx, { action: 'waitlist.entry.reminded', entityType: 'waitlist_entry', entityId: e.id, siteId: e.siteId, after: { reminderDays: reached, daysLeft: left } })
        out.reminded++
      }))
    }
    return out
  },
})

registerSweep({
  name: 'waitlist_offer_expiry',
  description: 'Expires a bed offer 48 hours after confirmed delivery with no answer: releases the hold, keeps the place in the queue and tells the Accommodation Admin who is next. Never creates the next offer.',
  async run(ctx) {
    const out: Record<string, number> = { expired: 0, failed: 0 }
    const due = await ctx.db.select({ id: bedOffer.id }).from(bedOffer).where(and(eq(bedOffer.status, 'pending'), lte(bedOffer.expiresAt, ctx.now)))
    await each(ctx, due.map(d => d.id), out, id => systemTx(ctx, async tx => {
      const l = await loadOfferLocked(tx, id)
      if (!l || l.offer.status !== 'pending' || !l.offer.expiresAt || l.offer.expiresAt.getTime() > ctx.now.getTime()) return
      const { offer, entry } = l
      const lbl = await bedLabel(tx, offer.bedId)
      await endOffer(tx, offer, { status: 'expired', note: 'No answer within the offer window', now: ctx.now })
      if (entry && entry.status === 'offered') {
        // Not a decline: the place and the decline count stay as they were. The bed is skipped so the same person is not offered it again.
        await tx.update(waitlistEntry).set({ status: 'waiting', skipBedIds: entry.skipBedIds.includes(offer.bedId) ? entry.skipBedIds : [...entry.skipBedIds, offer.bedId] }).where(eq(waitlistEntry.id, entry.id))
      }
      await auditSystem(tx, ctx, {
        action: 'waitlist.offer.expired', entityType: 'bed_offer', entityId: offer.id, siteId: lbl.siteId, reason: 'No answer within the offer window',
        before: { status: 'pending', deliveredAt: offer.deliveredAt?.toISOString(), expiresAt: offer.expiresAt?.toISOString() }, after: { status: 'expired', entryStatus: entry && entry.status !== 'closed' ? 'waiting' : entry?.status ?? null, holdReleased: true, placeKept: true },
      })
      await notify(tx, {
        dedupeKey: `offer:${offer.id}:expired`, kind: 'offer.expired', to: { staffId: offer.staffId },
        text: `Your offer of bed ${lbl.code} ended because it was not answered in time. You stay on the waitlist and keep your place while the entry is valid.`, ref: { type: 'bed_offer', id: offer.id },
      })
      await notifyFreedBed(tx, offer.bedId, ctx.now, `offer:${offer.id}:expired`)
      out.expired++
    }))
    return out
  },
})

registerSweep({
  name: 'waitlist_offer_followup',
  description: 'When a bed offer has not been seen 24 hours after it was made, asks Reception to inform the resident in person or by phone and record it. Once per offer.',
  async run(ctx) {
    const out: Record<string, number> = { followedUp: 0, failed: 0 }
    const hours = await getConfig(ctx.db, 'timers.offer_unviewed_hours')
    const cutoff = new Date(ctx.now.getTime() - hours * HOUR)
    const due = await ctx.db.select({ id: bedOffer.id }).from(bedOffer).where(and(eq(bedOffer.status, 'pending'), isNull(bedOffer.deliveredAt), isNull(bedOffer.followUpSentAt), lte(bedOffer.createdAt, cutoff)))
    await each(ctx, due.map(d => d.id), out, id => systemTx(ctx, async tx => {
      const l = await loadOfferLocked(tx, id)
      if (!l || l.offer.status !== 'pending' || l.offer.deliveredAt || l.offer.followUpSentAt || l.offer.createdAt.getTime() > cutoff.getTime()) return
      const { offer } = l
      const lbl = await bedLabel(tx, offer.bedId)
      await tx.update(bedOffer).set({ followUpSentAt: ctx.now }).where(eq(bedOffer.id, offer.id))
      await notify(tx, {
        dedupeKey: `offer:${offer.id}:followup`, kind: 'offer.follow_up', to: { role: 'Rec', siteId: lbl.siteId },
        text: `${await staffName(tx, offer.staffId)} has not opened the bed offer for ${lbl.code} after ${hours} hours. Please tell them in person or by phone, then record "informed offline" on the offer. The 48 hours start only once delivery is confirmed.`,
        ref: { type: 'bed_offer', id: offer.id },
      })
      await auditSystem(tx, ctx, { action: 'waitlist.offer.follow_up', entityType: 'bed_offer', entityId: offer.id, siteId: lbl.siteId, after: { followUpSentAt: ctx.now.toISOString(), unviewedHours: hours } })
      out.followedUp++
    }))
    return out
  },
})
