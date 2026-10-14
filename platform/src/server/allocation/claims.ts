/**
 * The ONLY place that writes bed_claim (tests/api/allocation-boundary.test.ts greps for violations).
 * A claim is one bed for one date range; it is never deleted, a release sets released_at and a reason.
 * The database exclusion constraint no_double_allocation is the last line of defence behind allocateBed().
 */
import { and, eq, isNull, sql } from 'drizzle-orm'
import { bedClaim } from '@/server/db/schema'
import type { Tx } from '@/server/command/context'
import type { ClaimKind } from '@/domain/enums'
import { claimPeriod } from '@/domain/claims'

export async function insertClaim(tx: Tx, a: { bedId: string; kind: ClaimKind; from: string; to?: string }): Promise<string> {
  const [row] = await tx.insert(bedClaim).values({ bedId: a.bedId, kind: a.kind, period: claimPeriod(a.from, a.to) }).returning({ id: bedClaim.id })
  return row.id
}

/** offer_hold -> reservation (offer accepted) or reservation -> stay (check-in), in place. The database refuses any other move. */
export async function convertClaim(tx: Tx, claimId: string, to: ClaimKind): Promise<void> {
  await tx.update(bedClaim).set({ kind: to }).where(and(eq(bedClaim.id, claimId), isNull(bedClaim.releasedAt)))
}

/** Releases a live claim. Returns false if it was already released (callers decide whether that matters). */
export async function releaseClaim(tx: Tx, claimId: string, reason: string, now: Date): Promise<boolean> {
  const rows = await tx.update(bedClaim).set({ releasedAt: now, releaseReason: reason })
    .where(and(eq(bedClaim.id, claimId), isNull(bedClaim.releasedAt))).returning({ id: bedClaim.id })
  return rows.length > 0
}

/** Changes the dates of a live claim (extension, early departure). The exclusion constraint rejects an overlap. */
export async function setClaimPeriod(tx: Tx, claimId: string, from: string, to?: string): Promise<void> {
  await tx.update(bedClaim).set({ period: claimPeriod(from, to) }).where(and(eq(bedClaim.id, claimId), isNull(bedClaim.releasedAt)))
}

/** Live claims on a bed that overlap [from, to). Dates are plain 'YYYY-MM-DD'; `to` undefined means open-ended. */
export async function overlappingClaims(q: Pick<Tx, 'select'>, bedId: string, from: string, to?: string, ignoreIds: string[] = []) {
  const period = claimPeriod(from, to)
  const rows = await q.select({ id: bedClaim.id, kind: bedClaim.kind, from: sql<string>`lower(${bedClaim.period})::text`, to: sql<string | null>`upper(${bedClaim.period})::text` })
    .from(bedClaim)
    .where(and(eq(bedClaim.bedId, bedId), isNull(bedClaim.releasedAt), sql`${bedClaim.period} && ${period}::daterange`))
  return rows.filter(r => !ignoreIds.includes(r.id))
}
