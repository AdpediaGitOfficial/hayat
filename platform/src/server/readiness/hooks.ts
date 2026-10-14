/**
 * Every time a bed moves to Needs cleaning (checkout, transfer source, unblock, failed inspection) exactly one cleaning
 * task is opened for it (the database allows one open task per bed, so calling this twice is harmless). Reception is
 * told. The bed only becomes Available again through a PASSED final inspection of that task (WP-J), never from here.
 */
import { eq } from 'drizzle-orm'
import { bed } from '@/server/db/schema'
import { cleaningTask } from '@/server/db/schema.stage3'
import type { Tx } from '@/server/command/context'
import { notify } from '@/server/notify'

export async function openCleaningTask(tx: Tx, a: { bedId: string; reason: string; now: Date }): Promise<{ taskId: string; created: boolean } | undefined> {
  const [b] = await tx.select({ id: bed.id, siteId: bed.siteId, code: bed.code }).from(bed).where(eq(bed.id, a.bedId)).limit(1)
  if (!b) return undefined
  const rows = await tx.insert(cleaningTask).values({ bedId: b.id, siteId: b.siteId, reason: a.reason, createdAt: a.now }).onConflictDoNothing().returning({ id: cleaningTask.id })
  if (rows.length === 0) return { taskId: '', created: false }
  await notify(tx, {
    dedupeKey: `cleaning:${rows[0].id}:opened`, kind: 'cleaning.opened', to: { role: 'Rec', siteId: b.siteId }, ref: { type: 'cleaning_task', id: rows[0].id },
    text: `Bed ${b.code} needs cleaning (${a.reason}). Assign a housekeeper.`,
  })
  return { taskId: rows[0].id, created: true }
}
