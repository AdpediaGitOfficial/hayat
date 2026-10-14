import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { accommodationRequest } from '@/server/db/schema'
import { audit } from '@/server/audit'
import { authorize } from '@/server/command/authorize'
import { runCommand } from '@/server/command/run'
import type { RequestContext } from '@/server/command/context'
import { fail, ok, type Result } from '@/server/command/result'
import { can } from '@/server/policy'
import { idSchema, isRequester, loadRequest, notifyRequester, reasonSchema, snapRequest, withdrawOpenAsk, wrongState } from './shared'

export const cancelInput = z.object({ requestId: idSchema, reason: reasonSchema })
export type CancelRequestInput = z.infer<typeof cancelInput>

/**
 * Withdraws a request that has not become a reservation. The requester (or the officer who filed it) may do it, and so may an
 * Accommodation Admin at the site. An approved request has a reservation: that is cancelled instead (cancelReservation).
 */
export function cancelRequest(rc: RequestContext, i: CancelRequestInput): Promise<Result<{ requestId: string; status: 'cancelled' }>> {
  return runCommand(rc, async c => {
    const peek = await loadRequest(c.tx, i.requestId)
    if (!peek) return fail.notFound()
    const denied = authorize(c, 'requests_waitlist.view', { siteId: peek.siteId, ownerStaffId: peek.staffId })
    if (denied) return denied
    const admin = can(c.actor, 'requests_waitlist.approve', { siteId: peek.siteId })
    if (!isRequester(c, peek) && !admin) return fail.forbidden('cancel this request', 'The person who filed it, or an Accommodation Admin')

    const r = await loadRequest(c.tx, i.requestId, true)
    if (!r) return fail.notFound()
    if (r.status === 'cancelled') {
      if (r.decidedBy === c.user.id) return ok({ requestId: r.id, status: 'cancelled' as const }, 'Already cancelled.') // a retried call
      return wrongState(r, 'cancelled again')
    }
    if (!['submitted', 'pending_approval', 'changes_requested'].includes(r.status)) return wrongState(r, 'cancelled')

    const withdrawn = await withdrawOpenAsk(c, r.id)
    await c.tx.update(accommodationRequest).set({ status: 'cancelled', decidedBy: c.user.id, decidedAt: c.now, decisionReason: i.reason }).where(eq(accommodationRequest.id, r.id))
    await audit(c, {
      action: 'requests.request.cancelled', entityType: 'request', entityId: r.id, siteId: r.siteId, reason: i.reason,
      before: snapRequest(r), after: { ...snapRequest(r), status: 'cancelled', exceptionAskWithdrawn: withdrawn ?? null },
    })
    // The person is told when somebody else cancelled for them.
    await notifyRequester(c.tx, r, `request:${r.id}:cancelled`, 'request.cancelled', `Your accommodation request was cancelled: ${i.reason}`, { except: c.actor.staffId })
    return ok({ requestId: r.id, status: 'cancelled' as const }, 'Request cancelled.')
  })
}
