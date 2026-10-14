import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { bed } from '@/server/db/schema'
import { bedBlock } from '@/server/db/schema.property'
import { audit } from '@/server/audit'
import { authorize } from '@/server/command/authorize'
import { runCommand } from '@/server/command/run'
import type { RequestContext } from '@/server/command/context'
import { fail, failure, ok, type Result } from '@/server/command/result'
import { claimOverlapsBlock, upcomingClaims, type UpcomingClaim } from './claims'
import { idSchema, loadBed, loadSite, reasonSchema, snap, todayInZone } from './shared'

export const input = z.object({
  bedId: idSchema,
  reason: reasonSchema,
  /** The LAST blocked day (D-103 note: blocks use "until", unlike stays, which use the departure day). Empty = until further notice. */
  until: z.iso.date('Use a date like 2026-11-30').nullish().transform(v => v ?? null),
})
export type BlockBedInput = z.infer<typeof input>

export interface BlockBedOut {
  bedId: string
  state: 'blocked'
  reason: string
  until: string | null
  /** Reservations, holds and stays still on the books for this bed. Blocking never cancels or moves them. */
  upcomingClaims: (UpcomingClaim & { overlapsBlock: boolean })[]
}

/**
 * Blocks a bed: it cannot be allocated while blocked. Safest behaviour for what already exists on the bed (D-19, SRS Appendix B):
 *  - an OCCUPIED bed cannot be blocked at all (the resident would have to be moved by a person first),
 *  - a bed with future reservations CAN be blocked, nothing is cancelled or moved, and the answer lists those claims so the
 *    admin can act on them (cancel, move to another bed, or shorten the block). They are also written into the audit row.
 * Readiness is separate: a bed that still needs cleaning or inspection may be blocked too.
 */
export function blockBed(rc: RequestContext, i: BlockBedInput): Promise<Result<BlockBedOut>> {
  return runCommand(rc, async c => {
    const b = await loadBed(c.tx, i.bedId, 'update')
    if (!b) return fail.notFound()
    const denied = authorize(c, 'rooms_beds.block', { siteId: b.siteId })
    if (denied) return denied

    if (b.state === 'archived') return failure('conflict', `Bed ${b.code} is archived and cannot be blocked`, { owner: 'Accommodation Admin', next: 'Archived beds are final. Add a new bed if the space is in use again' })
    if (b.state === 'blocked') return failure('conflict', `Bed ${b.code} is already blocked`, { owner: 'Accommodation Admin', next: 'Unblock it first if the reason or date must change' })
    if (b.state === 'occupied') {
      return failure('conflict', `Bed ${b.code} is occupied, so it can't be blocked`, {
        owner: 'Accommodation Admin',
        next: 'Check the resident out or transfer them to another bed first, then block the bed',
        detail: { state: b.state },
      })
    }

    const site = await loadSite(c.tx, b.siteId)
    const today = todayInZone(c.now, site?.timeZone ?? 'UTC')
    if (i.until && i.until < today) {
      return fail.invalid('The "until" date is already past', { until: `Choose ${today} or later (last blocked day)` })
    }

    await c.tx.update(bed).set({ state: 'blocked', stateReason: i.reason, stateSince: c.now }).where(eq(bed.id, b.id))
    await c.tx.insert(bedBlock).values({ bedId: b.id, siteId: b.siteId, reason: i.reason, untilDate: i.until, blockedBy: c.user.id, blockedAt: c.now })

    const claims = (await upcomingClaims(c.tx, [b.id], today)).map(x => ({ ...x, overlapsBlock: claimOverlapsBlock(x, today, i.until) }))
    const affected = claims.filter(x => x.overlapsBlock)
    await audit(c, {
      action: 'property.bed.blocked', entityType: 'bed', entityId: b.id, siteId: b.siteId, reason: i.reason,
      before: snap.bed(b),
      after: { ...snap.bed({ ...b, state: 'blocked', stateReason: i.reason }), until: i.until, upcomingClaims: claims.length, claimsOverlappingBlock: affected.length },
    })
    const warn = affected.length
      ? ` ${affected.length} reservation${affected.length > 1 ? 's' : ''} or hold${affected.length > 1 ? 's' : ''} fall${affected.length > 1 ? '' : 's'} inside the block: nobody was moved, review ${affected.length > 1 ? 'them' : 'it'}.`
      : ''
    return ok({ bedId: b.id, state: 'blocked' as const, reason: i.reason, until: i.until, upcomingClaims: claims }, `Bed ${b.code} blocked.${warn}`)
  })
}
