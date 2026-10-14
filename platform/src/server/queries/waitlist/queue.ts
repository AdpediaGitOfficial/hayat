/**
 * Read side of the waitlist (WP-E). Every query takes the Actor and narrows rows in SQL by the policy's scope, so a row the actor
 * may not see is never fetched (AT-002). Staff see the queues of their sites; a resident sees only their own entry and offers.
 */
import { and, desc, eq, gte, inArray, ne } from 'drizzle-orm'
import { bed, room, site, staffProfile } from '@/server/db/schema'
import { bedOffer, waitlistEntry, waitlistPriorityRequest } from '@/server/db/schema.waitlist'
import type { Db } from '@/server/db/client'
import type { Action, Actor } from '@/server/policy'
import { decide, scopeFilter } from '@/server/policy'
import { getConfig } from '@/server/config/registry'
import { suggestBeds, type BedSuggestion } from '@/server/allocation'
import { sortQueue } from '@/server/commands/waitlist/queue'
import { claimDates, offerWindow } from '@/server/commands/waitlist/shared'
import { todayInZone } from '@/server/commands/property/shared'

type Reader = Pick<Db, 'select'>

/** Staff actions that give a look into a site's queue; the union of their site scopes is what the actor may see. */
const STAFF_ACTIONS: readonly Action[] = ['requests_waitlist.view', 'requests_waitlist.manage_waitlist', 'requests_waitlist.manage_offers', 'requests_waitlist.record_offline_offer', 'requests_waitlist.approve_exception']

/** 'all', or the site ids (possibly none) the actor may see queues of. */
export function queueSites(actor: Actor): 'all' | string[] {
  const ids = new Set<string>()
  for (const a of STAFF_ACTIONS) {
    const f = scopeFilter(actor, a)
    if (f.kind === 'all') return 'all'
    if (f.kind === 'restricted') for (const s of f.siteIds) ids.add(s)
  }
  return [...ids]
}

export interface OfferInFlight {
  id: string
  bedCode: string
  roomName: string
  status: 'pending' | 'accepted' | 'declined' | 'expired' | 'withdrawn'
  createdAt: string
  deliveredAt: string | null
  deliveredVia: 'viewed' | 'email' | 'offline' | null
  expiresAt: string | null
  followUpSentAt: string | null
  from: string
  to: string | null
}
export interface PendingPriority { id: string; category: string; reason: string; evidence: string; requestedAt: string }
export interface QueueEntryView {
  id: string
  position: number
  staffId: string
  name: string
  employeeId: string
  department: string | null
  priority: string | null
  status: 'waiting' | 'offered'
  arrival: string
  end: string | null
  stayType: string
  createdAt: string
  expiresAt: string
  declines: number
  renewals: number
  remindersSent: number[]
  requestId: string | null
  onBehalf: boolean
  pendingPriority: PendingPriority | null
  offer: OfferInFlight | null
}
export interface SiteQueue { siteId: string; siteName: string; siteCode: string; entries: QueueEntryView[] }

async function offerView(db: Reader, o: typeof bedOffer.$inferSelect): Promise<OfferInFlight> {
  const [b] = await db.select({ code: bed.code, roomName: room.name }).from(bed).innerJoin(room, eq(room.id, bed.roomId)).where(eq(bed.id, o.bedId)).limit(1)
  const d = await claimDates(db, o.claimId)
  return {
    id: o.id, bedCode: b?.code ?? '?', roomName: b?.roomName ?? '?', status: o.status, createdAt: o.createdAt.toISOString(),
    deliveredAt: o.deliveredAt?.toISOString() ?? null, deliveredVia: o.deliveredVia, expiresAt: o.expiresAt?.toISOString() ?? null,
    followUpSentAt: o.followUpSentAt?.toISOString() ?? null, from: d?.from ?? '', to: d?.to ?? null,
  }
}

/** The live queue per site, in queue order, with each person's pending offer and pending priority request. Staff only. */
export async function listQueues(db: Reader, actor: Actor, o: { siteId?: string } = {}): Promise<SiteQueue[]> {
  const scope = queueSites(actor)
  if (scope !== 'all' && scope.length === 0) return []
  const sites = await db.select({ id: site.id, name: site.name, code: site.code }).from(site)
    .where(and(scope === 'all' ? undefined : inArray(site.id, scope), o.siteId ? eq(site.id, o.siteId) : undefined)).orderBy(site.code)
  if (sites.length === 0) return []
  const siteIds = sites.map(s => s.id)

  const rows = await db.select({ e: waitlistEntry, name: staffProfile.fullName, employeeId: staffProfile.employeeId, department: staffProfile.department })
    .from(waitlistEntry).innerJoin(staffProfile, eq(staffProfile.id, waitlistEntry.staffId))
    .where(and(inArray(waitlistEntry.siteId, siteIds), ne(waitlistEntry.status, 'closed')))
  const offers = rows.length ? await db.select().from(bedOffer).where(and(inArray(bedOffer.waitlistEntryId, rows.map(r => r.e.id)), eq(bedOffer.status, 'pending'))) : []
  const priorities = rows.length ? await db.select().from(waitlistPriorityRequest).where(and(inArray(waitlistPriorityRequest.entryId, rows.map(r => r.e.id)), eq(waitlistPriorityRequest.status, 'pending'))) : []
  const cats = await getConfig(db, 'eligibility.priority_categories')

  const out: SiteQueue[] = []
  for (const s of sites) {
    const mine = rows.filter(r => r.e.siteId === s.id)
    const ordered = sortQueue(mine.map(r => ({ ...r, id: r.e.id, priority: r.e.priority, queueTs: r.e.queueTs })), cats)
    const entries: QueueEntryView[] = []
    for (const [i, r] of ordered.entries()) {
      const offer = offers.find(x => x.waitlistEntryId === r.e.id)
      const pp = priorities.find(x => x.entryId === r.e.id)
      entries.push({
        id: r.e.id, position: i + 1, staffId: r.e.staffId, name: r.name, employeeId: r.employeeId, department: r.department, priority: r.e.priority,
        status: r.e.status === 'offered' ? 'offered' : 'waiting', arrival: r.e.arrivalDate, end: r.e.endDate, stayType: r.e.stayType,
        createdAt: r.e.createdAt.toISOString(), expiresAt: r.e.expiresAt.toISOString(), declines: r.e.declines, renewals: r.e.renewals, remindersSent: r.e.remindersSent,
        requestId: r.e.requestId, onBehalf: r.e.onBehalf,
        pendingPriority: pp ? { id: pp.id, category: pp.category, reason: pp.reason, evidence: pp.evidence, requestedAt: pp.createdAt.toISOString() } : null,
        offer: offer ? await offerView(db, offer) : null,
      })
    }
    out.push({ siteId: s.id, siteName: s.name, siteCode: s.code, entries })
  }
  return actor.role === 'Mgr' ? out.map(summary) : out
}

/** The Read-only Manager sees "Summary" (PERMISSIONS.md): the queue's shape and timers, never who the people are or why they were prioritised. */
function summary(q: SiteQueue): SiteQueue {
  return {
    ...q,
    entries: q.entries.map(e => ({
      ...e, staffId: '', name: `Waitlist entry ${e.position}`, employeeId: '', department: null, requestId: null,
      pendingPriority: e.pendingPriority && { ...e.pendingPriority, reason: '', evidence: '' },
    })),
  }
}

export interface MyWaitlist {
  entry: (Omit<QueueEntryView, 'name' | 'employeeId' | 'department' | 'pendingPriority' | 'offer'> & { siteId: string; siteName: string; queueLength: number }) | null
  offer: OfferInFlight | null
  /** The most recent offer that ended in the last 14 days (accepted, declined, expired, withdrawn). */
  lastEnded: OfferInFlight | null
}

/** A resident's own waitlist entry and offers. Never anyone else's. */
export async function myWaitlist(db: Reader, staffId: string, now: Date): Promise<MyWaitlist> {
  const [row] = await db.select({ e: waitlistEntry, siteName: site.name }).from(waitlistEntry).innerJoin(site, eq(site.id, waitlistEntry.siteId))
    .where(and(eq(waitlistEntry.staffId, staffId), ne(waitlistEntry.status, 'closed'))).limit(1)
  let entry: MyWaitlist['entry'] = null
  if (row) {
    const peers = await db.select({ id: waitlistEntry.id, priority: waitlistEntry.priority, queueTs: waitlistEntry.queueTs }).from(waitlistEntry)
      .where(and(eq(waitlistEntry.siteId, row.e.siteId), ne(waitlistEntry.status, 'closed')))
    const ordered = sortQueue(peers, await getConfig(db, 'eligibility.priority_categories'))
    const e = row.e
    entry = {
      id: e.id, position: ordered.findIndex(p => p.id === e.id) + 1, queueLength: ordered.length, staffId: e.staffId, priority: e.priority, status: e.status === 'offered' ? 'offered' : 'waiting',
      arrival: e.arrivalDate, end: e.endDate, stayType: e.stayType, createdAt: e.createdAt.toISOString(), expiresAt: e.expiresAt.toISOString(), declines: e.declines,
      renewals: e.renewals, remindersSent: e.remindersSent, requestId: e.requestId, onBehalf: e.onBehalf, siteId: e.siteId, siteName: row.siteName,
    }
  }
  const [pending] = await db.select().from(bedOffer).where(and(eq(bedOffer.staffId, staffId), eq(bedOffer.status, 'pending'))).limit(1)
  const since = new Date(now.getTime() - 14 * 86_400_000)
  const [ended] = await db.select().from(bedOffer)
    .where(and(eq(bedOffer.staffId, staffId), inArray(bedOffer.status, ['accepted', 'declined', 'expired', 'withdrawn']), gte(bedOffer.updatedAt, since))).orderBy(desc(bedOffer.updatedAt)).limit(1)
  return { entry, offer: pending ? await offerView(db, pending) : null, lastEnded: ended ? await offerView(db, ended) : null }
}

/**
 * Beds this person could be offered, ready beds first (no bed already held or reserved for their dates, not a bed they turned down).
 * Undefined when the actor may not manage offers for the entry's site (answered as not found).
 */
export async function offerCandidates(db: Reader, actor: Actor, entryId: string, now: Date): Promise<BedSuggestion[] | undefined> {
  const [row] = await db.select({ e: waitlistEntry, tz: site.timeZone }).from(waitlistEntry).innerJoin(site, eq(site.id, waitlistEntry.siteId)).where(eq(waitlistEntry.id, entryId)).limit(1)
  if (!row || !decide(actor, 'requests_waitlist.manage_offers', { siteId: row.e.siteId }).allowed) return undefined
  if (row.e.status !== 'waiting') return []
  const w = offerWindow(row.e, todayInZone(now, row.tz))
  if (!w) return []
  return suggestBeds(db, { staffId: row.e.staffId, siteId: row.e.siteId, from: w.from, to: w.to, limit: 12, excludeBedIds: row.e.skipBedIds, requestId: row.e.requestId ?? undefined, now })
}
