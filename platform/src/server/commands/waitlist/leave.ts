import { z } from 'zod'
import { audit } from '@/server/audit'
import { authorize } from '@/server/command/authorize'
import { runCommand } from '@/server/command/run'
import type { RequestContext } from '@/server/command/context'
import { done, fail, type Result } from '@/server/command/result'
import { notify } from '@/server/notify'
import { queuePosition } from './queue'
import { closeEntry, idSchema, loadEntry, reasonSchema } from './shared'

export const input = z.object({ entryId: idSchema, reason: reasonSchema })
export type LeaveInput = z.infer<typeof input>

/**
 * Takes a person off the waitlist: the person themselves, or Reception, the Accommodation Admin or the Super Admin for them.
 * A bed offer still pending is withdrawn and its hold released; a linked request is cancelled. Safe to repeat: leaving an
 * entry that is already closed answers success without changing anything.
 */
export function leaveWaitlist(rc: RequestContext, i: LeaveInput): Promise<Result> {
  return runCommand(rc, async c => {
    const peek = await loadEntry(c.tx, i.entryId)
    if (!peek) return fail.notFound()
    const denied = authorize(c, 'requests_waitlist.submit', { siteId: peek.siteId, ownerStaffId: peek.staffId })
    if (denied) return denied
    const e = await loadEntry(c.tx, i.entryId, true)
    if (!e || e.status === 'closed') return done('Already off the waitlist')

    const before = { status: e.status, position: await queuePosition(c.tx, e.siteId, e.id) }
    const mine = c.actor.staffId === e.staffId
    const { offer } = await closeEntry(c.tx, e, {
      reason: 'left', now: c.now, offerNote: `Withdrawn: ${mine ? 'the resident' : 'staff'} took the entry off the waitlist (${i.reason})`,
      requestStatus: 'cancelled', requestNote: `Left the waitlist: ${i.reason}`,
    })
    await audit(c, {
      action: 'waitlist.entry.left', entityType: 'waitlist_entry', entityId: e.id, siteId: e.siteId, reason: i.reason,
      before, after: { status: 'closed', closeReason: 'left', offerWithdrawn: offer?.id ?? null, onBehalf: !mine },
    })
    if (!mine) {
      await notify(c.tx, { dedupeKey: `waitlist:${e.id}:left`, kind: 'waitlist.left', to: { staffId: e.staffId }, text: `You were taken off the waitlist (${i.reason}). Ask Reception if you still need a bed.`, ref: { type: 'waitlist_entry', id: e.id } })
    }
    return done('Taken off the waitlist')
  })
}
