/**
 * What the approval screen needs to pick a bed (D-44): suggestions that are eligible and free for the request's dates, and
 * the other beds of the site with whether they are free. Visible to those who may approve at the site.
 */
import { and, asc, eq, isNull, notInArray, sql } from 'drizzle-orm'
import { accommodationRequest, bed, bedClaim, room } from '@/server/db/schema'
import type { Db } from '@/server/db/client'
import { suggestBeds, type BedSuggestion } from '@/server/allocation'
import { claimPeriod } from '@/domain/claims'
import { type Actor } from '@/server/policy'
import { standingNow } from '@/server/approvals/escalation'

type Reader = Pick<Db, 'select'>

export interface BedChoice { bedId: string; code: string; roomName: string; state: string; free: boolean; suggested: boolean }
export interface BedsForRequest { requestId: string; siteId: string; suggestions: BedSuggestion[]; beds: BedChoice[] }

export async function bedsForRequest(db: Reader, actor: Actor, requestId: string, now: Date): Promise<BedsForRequest | undefined> {
  const [r] = await db.select().from(accommodationRequest).where(eq(accommodationRequest.id, requestId))
  if (!r) return undefined
  // Whoever may decide the request now (the Accommodation Admin, or from the backup level a Policy Approver / Backup Approver: P-01, pending sign-off).
  if (!(await standingNow(db, actor, { primary: 'requests_waitlist.approve', siteId: r.siteId, since: r.updatedAt, now })).ok) return undefined
  const suggestions = await suggestBeds(db, { staffId: r.staffId, siteId: r.siteId, from: r.arrivalDate, to: r.endDate ?? undefined, limit: 12, requestId: r.id, now })
  const period = claimPeriod(r.arrivalDate, r.endDate ?? undefined)
  const rows = await db.select({
    bedId: bed.id, code: bed.code, roomName: room.name, state: bed.state,
    free: sql<boolean>`NOT EXISTS (SELECT 1 FROM ${bedClaim} WHERE ${bedClaim.bedId} = ${bed.id} AND ${bedClaim.releasedAt} IS NULL AND ${bedClaim.period} && ${period}::daterange)`,
  }).from(bed).innerJoin(room, eq(room.id, bed.roomId))
    .where(and(eq(bed.siteId, r.siteId), isNull(bed.archivedAt), isNull(room.archivedAt), notInArray(bed.state, ['blocked', 'under_maintenance', 'archived'])))
    .orderBy(asc(room.name), asc(bed.code)).limit(400)
  const sug = new Set(suggestions.map(s => s.bedId))
  return { requestId: r.id, siteId: r.siteId, suggestions, beds: rows.map(b => ({ ...b, suggested: sug.has(b.bedId) })) }
}
