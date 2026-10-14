/**
 * Queue order and matching (D-53): approved priority category first (earlier in the configured list = more urgent),
 * then the oldest valid waiting timestamp, ties by id. Position 1 is next in line. The position is a "sequence number":
 * the audit records it before and after anything that changes it (AT-013).
 *
 * matchFreedBed() is what Stage 3 calls when a bed becomes available (Mark as Left, checkout, unblock); it only FINDS
 * the next eligible person. Creating the offer is a person's decision (createOffer, "offer to next"), never a timer's.
 */
import { and, eq, gt, inArray, isNull, ne, sql } from 'drizzle-orm'
import { bed, reservation, site, stay } from '@/server/db/schema'
import { waitlistEntry } from '@/server/db/schema.waitlist'
import type { Tx } from '@/server/command/context'
import { OCCUPYING_STAY_STATUSES } from '@/domain/enums'
import { overlappingClaims } from '@/server/allocation'
import { checkEligibility } from '@/server/eligibility'
import { getConfig } from '@/server/config/registry'
import { notify } from '@/server/notify'
import { todayInZone } from '@/server/commands/property/shared'
import { bedLabel, offerWindow, staffName, type EntryRow } from './shared'
import { offerNotReady } from './offerReadiness'

type Reader = Pick<Tx, 'select'>

export interface QueueRow { id: string; staffId: string; priority: string | null; queueTs: Date; status: EntryRow['status'] }

/** Pure ordering, exported for tests and screens. `categories` is the configured priority list, most urgent first. */
export function sortQueue<T extends { id: string; priority: string | null; queueTs: Date }>(rows: readonly T[], categories: readonly string[]): T[] {
  const rank = (p: string | null) => { const i = p ? categories.indexOf(p) : -1; return i >= 0 ? i : categories.length }
  return [...rows].sort((a, b) => rank(a.priority) - rank(b.priority) || a.queueTs.getTime() - b.queueTs.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** Every live entry of a site, in queue order. */
export async function queueOrder(q: Reader, siteId: string): Promise<QueueRow[]> {
  const rows = await q.select({ id: waitlistEntry.id, staffId: waitlistEntry.staffId, priority: waitlistEntry.priority, queueTs: waitlistEntry.queueTs, status: waitlistEntry.status })
    .from(waitlistEntry).where(and(eq(waitlistEntry.siteId, siteId), ne(waitlistEntry.status, 'closed')))
  return sortQueue(rows, await getConfig(q, 'eligibility.priority_categories'))
}

/** 1-based sequence number of an entry among the live entries of its site, or undefined when it is not in the queue. */
export async function queuePosition(q: Reader, siteId: string, entryId: string): Promise<number | undefined> {
  const i = (await queueOrder(q, siteId)).findIndex(r => r.id === entryId)
  return i < 0 ? undefined : i + 1
}

export interface Match {
  entryId: string; staffId: string; siteId: string; position: number; from: string; to?: string
  /**
   * Set when the bed is not ready and the hold would start inside the lead time (P-13, proposed, pending client sign-off): the match is
   * still shown, with the reason, owner and next action, but an offer on it is refused until the bed is ready or the start is later.
   */
  notReady?: { reason: string; owner: string; next: string }
}

/** Whether this person can be housed at all right now: no reservation waiting, no bed already (a pending offer is the entry's own business). */
export async function alreadyHoused(q: Reader, staffId: string): Promise<boolean> {
  const [r] = await q.select({ n: sql<number>`count(*)::int` }).from(reservation).where(and(eq(reservation.staffId, staffId), eq(reservation.status, 'reserved'), isNull(reservation.archivedAt)))
  if (r.n > 0) return true
  const [s] = await q.select({ n: sql<number>`count(*)::int` }).from(stay).where(and(eq(stay.staffId, staffId), inArray(stay.status, [...OCCUPYING_STAY_STATUSES])))
  return s.n > 0
}

/**
 * The next person in the queue who can take this bed: waiting (no offer out), entry still valid, has not already declined
 * or let lapse this bed, nothing else holds the bed for their dates, no bed or reservation of their own, and eligible.
 * Returns undefined when nobody fits. Read-only.
 */
export async function matchFreedBed(q: Reader, bedId: string, now: Date, o: { limit?: number } = {}): Promise<Match | undefined> {
  return (await matchesForBed(q, bedId, now, { limit: o.limit ?? 1 }))[0]
}

export async function matchesForBed(q: Reader, bedId: string, now: Date, o: { limit?: number } = {}): Promise<Match[]> {
  const [b] = await q.select({ siteId: bed.siteId, code: bed.code, state: bed.state, archivedAt: bed.archivedAt, tz: site.timeZone }).from(bed).innerJoin(site, eq(site.id, bed.siteId)).where(eq(bed.id, bedId)).limit(1)
  if (!b || b.archivedAt || ['blocked', 'under_maintenance', 'archived'].includes(b.state)) return []
  const order = await queueOrder(q, b.siteId)
  if (order.length === 0) return []
  const waiting = new Map((await q.select().from(waitlistEntry).where(and(eq(waitlistEntry.siteId, b.siteId), eq(waitlistEntry.status, 'waiting'), gt(waitlistEntry.expiresAt, now)))).map(e => [e.id, e]))
  const today = todayInZone(now, b.tz)
  const out: Match[] = []
  for (const [i, row] of order.entries()) {
    const e = waiting.get(row.id)
    if (!e || e.skipBedIds.includes(bedId)) continue
    const w = offerWindow(e, today)
    if (!w) continue
    if ((await overlappingClaims(q, bedId, w.from, w.to)).length > 0) continue
    if (await alreadyHoused(q, e.staffId)) continue
    const el = await checkEligibility(q, e.staffId, bedId, now, { requestId: e.requestId ?? undefined })
    if (!el?.ok) continue
    const refusal = await offerNotReady(q, { id: bedId, code: b.code, state: b.state, siteId: b.siteId }, w.from, today)
    out.push({
      entryId: e.id, staffId: e.staffId, siteId: b.siteId, position: i + 1, from: w.from, to: w.to,
      ...(refusal ? { notReady: { reason: refusal.reason, owner: refusal.owner ?? '', next: refusal.next ?? '' } } : {}),
    })
    if (out.length >= (o.limit ?? 1)) break
  }
  return out
}

/**
 * Tells the Accommodation Admins of the bed's site that a bed is free and who is next in line. It does NOT create the offer
 * (no auto-allocation: D-45 spirit, CLAUDE.md "timeouts never decide"). Stage 3 calls this when a bed becomes available.
 * `eventKey` identifies the event so a retry or a second sweep notifies once. Returns true if a notification was created.
 */
export async function notifyFreedBed(tx: Tx, bedId: string, now: Date, eventKey: string): Promise<boolean> {
  const next = await matchFreedBed(tx, bedId, now)
  if (!next) return false
  const [b, who] = [await bedLabel(tx, bedId), await staffName(tx, next.staffId)]
  return notify(tx, {
    dedupeKey: `waitlist:bed:${bedId}:${eventKey}:next`, kind: 'waitlist.bed_free',
    to: { role: 'AA', siteId: next.siteId },
    // A bed that is not ready yet is shown with the reason (P-13), so nobody tries to offer it too early.
    text: next.notReady
      ? `Bed ${b.code} (${b.roomName}) is free from ${next.from} but not ready yet. ${next.notReady.reason}. Owner: ${next.notReady.owner}. Next: ${next.notReady.next}. Next in the waitlist queue: ${who} (position ${next.position}).`
      : `Bed ${b.code} (${b.roomName}) is free from ${next.from}. Next in the waitlist queue: ${who} (position ${next.position}). Open the waitlist to offer it.`,
    ref: { type: 'waitlist_entry', id: next.entryId },
  })
}
