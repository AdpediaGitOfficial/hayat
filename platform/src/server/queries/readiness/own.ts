/** Which of these rooms does the person live in (a live stay in one of its beds)? Used to show "not your own room" before an action is attempted. */
import { and, eq, inArray } from 'drizzle-orm'
import { bed, stay } from '@/server/db/schema'
import { OCCUPYING_STAY_STATUSES } from '@/domain/enums'
import type { Db } from '@/server/db/client'

export async function livesInRoomIds(db: Pick<Db, 'select'>, staffId: string, roomIds: readonly string[]): Promise<Set<string>> {
  if (roomIds.length === 0) return new Set()
  const rows = await db.select({ roomId: bed.roomId }).from(stay).innerJoin(bed, eq(bed.id, stay.bedId))
    .where(and(eq(stay.staffId, staffId), inArray(stay.status, [...OCCUPYING_STAY_STATUSES]), inArray(bed.roomId, [...roomIds])))
  return new Set(rows.map(r => r.roomId))
}
