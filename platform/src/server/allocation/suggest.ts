import { and, asc, eq, isNull, notInArray, sql } from 'drizzle-orm'
import { bed, bedClaim, room } from '@/server/db/schema'
import type { Db } from '@/server/db/client'
import { checkEligibility } from '@/server/eligibility'
import { claimPeriod } from '@/domain/claims'

export interface BedSuggestion { bedId: string; code: string; roomName: string; state: string }

/**
 * Beds in a site that this person may take for [from, to): not blocked/maintenance/archived, no overlapping live claim,
 * eligible. Ready beds first, then beds that still need cleaning (readiness gates check-in, not the reservation, D-18).
 */
export async function suggestBeds(q: Pick<Db, 'select'>, o: {
  staffId: string; siteId: string; from: string; to?: string; limit?: number; excludeBedIds?: string[]; requestId?: string; now: Date
}): Promise<BedSuggestion[]> {
  const period = claimPeriod(o.from, o.to)
  const candidates = await q.select({ bedId: bed.id, code: bed.code, roomName: room.name, state: bed.state })
    .from(bed).innerJoin(room, eq(room.id, bed.roomId))
    .where(and(
      eq(bed.siteId, o.siteId), isNull(bed.archivedAt), isNull(room.archivedAt),
      notInArray(bed.state, ['blocked', 'under_maintenance', 'archived']),
      o.excludeBedIds?.length ? notInArray(bed.id, o.excludeBedIds) : undefined,
      sql`NOT EXISTS (SELECT 1 FROM ${bedClaim} WHERE ${bedClaim.bedId} = ${bed.id} AND ${bedClaim.releasedAt} IS NULL AND ${bedClaim.period} && ${period}::daterange)`,
    ))
    .orderBy(sql`(${bed.state} <> 'available')`, asc(room.name), asc(bed.code))
    .limit(60)
  const out: BedSuggestion[] = []
  for (const cand of candidates) {
    const e = await checkEligibility(q, o.staffId, cand.bedId, o.now, { requestId: o.requestId })
    if (e?.ok) out.push(cand)
    if (out.length >= (o.limit ?? 5)) break
  }
  return out
}
