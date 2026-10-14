import { and, eq, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { bed } from '@/server/db/schema'
import { bedBlock } from '@/server/db/schema.property'
import { audit } from '@/server/audit'
import { authorize } from '@/server/command/authorize'
import { runCommand } from '@/server/command/run'
import type { RequestContext } from '@/server/command/context'
import { fail, failure, ok, type Result } from '@/server/command/result'
import { idSchema, loadBed, optionalText, snap } from './shared'
import { openCleaningTask } from '@/server/readiness/hooks'

export const input = z.object({ bedId: idSchema, note: optionalText(500) })
export type UnblockBedInput = z.infer<typeof input>

/**
 * Lifts a block. The bed does NOT jump to Available: after a block it goes to Needs Cleaning and must pass cleaning and the
 * final inspection first (state_transition 'blocked -> needs_cleaning', D-64). Readiness gates check-in, not the reservations
 * that were kept while the bed was blocked.
 */
export function unblockBed(rc: RequestContext, i: UnblockBedInput): Promise<Result<{ bedId: string; state: 'needs_cleaning' }>> {
  return runCommand(rc, async c => {
    const b = await loadBed(c.tx, i.bedId, 'update')
    if (!b) return fail.notFound()
    const denied = authorize(c, 'rooms_beds.block', { siteId: b.siteId })
    if (denied) return denied
    if (b.state !== 'blocked') {
      return failure('conflict', `Bed ${b.code} is not blocked (it is ${b.state.replace(/_/g, ' ')})`, { owner: 'Accommodation Admin', next: 'Nothing to unblock' })
    }
    await c.tx.update(bed).set({ state: 'needs_cleaning', stateReason: null, stateSince: c.now }).where(eq(bed.id, b.id))
    await openCleaningTask(c.tx, { bedId: b.id, reason: 'Unblocked', now: c.now })
    await c.tx.update(bedBlock).set({ releasedAt: c.now, releasedBy: c.user.id }).where(and(eq(bedBlock.bedId, b.id), isNull(bedBlock.releasedAt)))
    await audit(c, {
      action: 'property.bed.unblocked', entityType: 'bed', entityId: b.id, siteId: b.siteId, reason: i.note ?? undefined,
      before: snap.bed(b), after: snap.bed({ ...b, state: 'needs_cleaning', stateReason: null }),
    })
    return ok({ bedId: b.id, state: 'needs_cleaning' as const }, `Bed ${b.code} unblocked. It needs cleaning and a final inspection before check-in`)
  })
}
