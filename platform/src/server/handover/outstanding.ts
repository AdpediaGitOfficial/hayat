/** What a person still holds: keys and assets that are issued, or lost or damaged and not yet resolved (D-73). */
import { and, asc, eq, inArray, isNull } from 'drizzle-orm'
import { handoverItem } from '@/server/db/schema.stage3'
import type { Db } from '@/server/db/client'

export const OUTSTANDING_STATUSES = ['issued', 'lost', 'damaged'] as const

export async function outstandingHandovers(q: Pick<Db, 'select'>, staffId: string) {
  return q.select().from(handoverItem)
    .where(and(eq(handoverItem.holderStaffId, staffId), inArray(handoverItem.status, [...OUTSTANDING_STATUSES]), isNull(handoverItem.archivedAt)))
    .orderBy(asc(handoverItem.createdAt))
}
