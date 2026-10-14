/**
 * Helpers for Stage 3 (Mark as Left, D-36) and WP-D (a cancelled request). They run inside the CALLER's command
 * transaction (pass its CommandContext `c`), so the audit rows carry the real actor and everything commits or rolls back together.
 */
import { and, eq, ne } from 'drizzle-orm'
import { bedOffer, waitlistEntry } from '@/server/db/schema.waitlist'
import { audit } from '@/server/audit'
import type { CommandContext } from '@/server/command/context'
import { notifyFreedBed } from './queue'
import { bedLabel, closeEntry, endOffer, loadEntry, loadOfferLocked } from './shared'

/** Closes every live waitlist entry of a person (and withdraws their pending offer). Returns how many entries were closed. */
export async function closeEntriesForStaff(c: CommandContext, staffId: string, reason: string): Promise<number> {
  const rows = await c.tx.select({ id: waitlistEntry.id }).from(waitlistEntry).where(and(eq(waitlistEntry.staffId, staffId), ne(waitlistEntry.status, 'closed')))
  let n = 0
  for (const r of rows) n += await closeOne(c, r.id, reason)
  return n
}

/** Closes the live entry that stands for a request (the request was cancelled or closed elsewhere). Returns whether one was closed. */
export async function closeEntryForRequest(c: CommandContext, requestId: string, reason: string): Promise<boolean> {
  const rows = await c.tx.select({ id: waitlistEntry.id }).from(waitlistEntry).where(and(eq(waitlistEntry.requestId, requestId), ne(waitlistEntry.status, 'closed')))
  let n = 0
  for (const r of rows) n += await closeOne(c, r.id, reason)
  return n > 0
}

async function closeOne(c: CommandContext, entryId: string, reason: string): Promise<number> {
  const e = await loadEntry(c.tx, entryId, true)
  if (!e || e.status === 'closed') return 0
  const { offer } = await closeEntry(c.tx, e, { reason, now: c.now, offerNote: `Withdrawn: ${reason}`, requestStatus: 'closed', requestNote: `Waitlist entry closed: ${reason}` })
  await audit(c, { action: 'waitlist.entry.closed', entityType: 'waitlist_entry', entityId: e.id, siteId: e.siteId, reason, before: { status: e.status }, after: { status: 'closed', closeReason: reason, offerWithdrawn: offer?.id ?? null } })
  return 1
}

/** Withdraws a person's pending bed offer (hold released, entry back to Waiting). Returns how many offers were withdrawn. */
export async function withdrawOffersForStaff(c: CommandContext, staffId: string, reason: string): Promise<number> {
  const rows = await c.tx.select({ id: bedOffer.id }).from(bedOffer).where(and(eq(bedOffer.staffId, staffId), eq(bedOffer.status, 'pending')))
  let n = 0
  for (const r of rows) {
    const l = await loadOfferLocked(c.tx, r.id)
    if (!l || l.offer.status !== 'pending') continue
    await endOffer(c.tx, l.offer, { status: 'withdrawn', note: reason, now: c.now })
    if (l.entry && l.entry.status === 'offered') await c.tx.update(waitlistEntry).set({ status: 'waiting' }).where(eq(waitlistEntry.id, l.entry.id))
    const lbl = await bedLabel(c.tx, l.offer.bedId)
    await audit(c, { action: 'waitlist.offer.withdrawn', entityType: 'bed_offer', entityId: l.offer.id, siteId: lbl.siteId, reason, before: { status: 'pending' }, after: { status: 'withdrawn' } })
    await notifyFreedBed(c.tx, l.offer.bedId, c.now, `offer:${l.offer.id}:withdrawn`)
    n++
  }
  return n
}
