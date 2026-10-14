/**
 * The clearance case as a "closer" for closeStayIfDone() (src/server/stays-close.ts): a stay counts as cleared when the person has a
 * Cleared clearance case that was opened after the stay started. A voluntary checkout has no case, so that stay is never closed by
 * pretending a clearance happened (D-64).
 *
 * This file has NO runtime import of stays-close.ts (only types), so stays-close.ts can register it without an import cycle.
 */
import { and, eq, sql } from 'drizzle-orm'
import { stay } from '@/server/db/schema'
import { clearanceCase } from '@/server/db/schema.exit'
import type { StayCloser } from '@/server/stays-close'

export const clearanceCloser: StayCloser = async (tx, s) => {
  const [r] = await tx.select({ id: clearanceCase.id }).from(clearanceCase).innerJoin(stay, eq(stay.id, s.id))
    .where(and(eq(clearanceCase.staffId, s.staffId), eq(clearanceCase.status, 'cleared'), sql`${clearanceCase.openedAt} >= ${stay.checkedInAt}`)).limit(1)
  return !!r
}
