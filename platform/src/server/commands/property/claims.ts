/** Read-only view of the claims on beds (written by Stage 2). Used by the block command and by the inventory queries. */
import { and, asc, inArray, isNull, sql } from 'drizzle-orm'
import { bedClaim } from '@/server/db/schema'
import type { Db } from '@/server/db/client'
import type { ClaimKind } from '@/domain/enums'

export interface UpcomingClaim {
  claimId: string
  bedId: string
  kind: ClaimKind
  /** First night, 'YYYY-MM-DD'. */
  from: string
  /** Departure day (end-exclusive, D-103); null = open-ended. */
  to: string | null
}

/** Live claims (not released) that have not entirely ended before `today`: current and future reservations, holds and stays. */
export async function upcomingClaims(q: Pick<Db, 'select'>, bedIds: string[], today: string): Promise<UpcomingClaim[]> {
  if (bedIds.length === 0) return []
  return q.select({
    claimId: bedClaim.id, bedId: bedClaim.bedId, kind: bedClaim.kind,
    from: sql<string>`lower(${bedClaim.period})::text`,
    to: sql<string | null>`upper(${bedClaim.period})::text`,
  }).from(bedClaim).where(and(
    inArray(bedClaim.bedId, bedIds), isNull(bedClaim.releasedAt),
    sql`(upper_inf(${bedClaim.period}) OR upper(${bedClaim.period}) > ${today}::date)`,
  )).orderBy(asc(sql`lower(${bedClaim.period})`))
}

/** Does a claim share a night with the blocked days [today .. until]? `until` is the LAST blocked day; null = no end. */
export function claimOverlapsBlock(c: Pick<UpcomingClaim, 'from' | 'to'>, today: string, until: string | null): boolean {
  const startsBeforeBlockEnds = until === null || c.from <= until
  const endsAfterBlockStarts = c.to === null || c.to > today
  return startsBeforeBlockEnds && endsAfterBlockStarts
}
