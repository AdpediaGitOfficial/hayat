import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { accommodationRequest } from '@/server/db/schema'
import { audit } from '@/server/audit'
import { authorize } from '@/server/command/authorize'
import { runCommand } from '@/server/command/run'
import type { CommandContext, RequestContext } from '@/server/command/context'
import { fail, ok, type Failure, type Result } from '@/server/command/result'
import { fmtDate } from '@/domain/time'
import { decisionSod, idSchema, loadRequest, notifyRequester, reasonSchema, revisionOf, snapRequest, withdrawOpenAsk, wrongState, type RequestRow } from './shared'

/** The request an Accommodation Admin is deciding: visible and in scope, not their own, and still undecided. Returns it locked. */
export async function loadForDecision(c: CommandContext, id: string, verb: string, wanted: string, allowed: readonly RequestRow['status'][]): Promise<Failure | RequestRow> {
  const peek = await loadRequest(c.tx, id)
  if (!peek) return fail.notFound()
  const denied = authorize(c, 'requests_waitlist.approve', { siteId: peek.siteId })
  if (denied) return denied
  const sod = decisionSod(c, peek, verb)
  if (sod) return sod
  const r = await loadRequest(c.tx, id, true)
  if (!r) return fail.notFound()
  if (!allowed.includes(r.status)) return wrongState(r, wanted)
  return r
}

export const decisionInput = z.object({ requestId: idSchema, reason: reasonSchema })
export type DecisionInput = z.infer<typeof decisionInput>
interface DecisionOut { requestId: string; status: string }

/** Sends the request back to the requester with a reason. Nothing is reserved; the requester edits and resubmits. */
export function requestChanges(rc: RequestContext, i: DecisionInput): Promise<Result<DecisionOut>> {
  return runCommand(rc, async c => {
    const peek = await loadRequest(c.tx, i.requestId)
    if (peek?.status === 'changes_requested' && peek.decidedBy === c.user.id) return ok({ requestId: peek.id, status: peek.status }, 'Already sent back.') // a retried call
    const r = await loadForDecision(c, i.requestId, 'send back this request', 'sent back', ['submitted', 'pending_approval'])
    if ('ok' in r) return r
    const withdrawn = await withdrawOpenAsk(c, r.id)
    const n = await revisionOf(c.tx, r.id)
    await c.tx.update(accommodationRequest).set({ status: 'changes_requested', decidedBy: c.user.id, decidedAt: c.now, decisionReason: i.reason }).where(eq(accommodationRequest.id, r.id))
    await audit(c, { action: 'requests.request.changes_requested', entityType: 'request', entityId: r.id, siteId: r.siteId, reason: i.reason, before: snapRequest(r), after: { ...snapRequest(r), status: 'changes_requested', exceptionAskWithdrawn: withdrawn ?? null } })
    await notifyRequester(c.tx, r, `request:${r.id}:changes:${n}`, 'request.changes_requested', `Your accommodation request needs changes: ${i.reason}`)
    return ok({ requestId: r.id, status: 'changes_requested' }, 'Sent back to the requester with your reason.')
  })
}

/** Rejects the request with a reason and tells the resident. A rejected request is final; a new one can be filed. */
export function rejectRequest(rc: RequestContext, i: DecisionInput): Promise<Result<DecisionOut>> {
  return runCommand(rc, async c => {
    const peek = await loadRequest(c.tx, i.requestId)
    if (peek?.status === 'rejected' && peek.decidedBy === c.user.id) return ok({ requestId: peek.id, status: peek.status }, 'Already rejected.') // a retried call
    const r = await loadForDecision(c, i.requestId, 'reject this request', 'rejected', ['submitted', 'pending_approval'])
    if ('ok' in r) return r
    const withdrawn = await withdrawOpenAsk(c, r.id)
    await c.tx.update(accommodationRequest).set({ status: 'rejected', decidedBy: c.user.id, decidedAt: c.now, decisionReason: i.reason }).where(eq(accommodationRequest.id, r.id))
    await audit(c, { action: 'requests.request.rejected', entityType: 'request', entityId: r.id, siteId: r.siteId, reason: i.reason, before: snapRequest(r), after: { ...snapRequest(r), status: 'rejected', exceptionAskWithdrawn: withdrawn ?? null } })
    await notifyRequester(c.tx, r, `request:${r.id}:rejected`, 'request.rejected', `Your accommodation request for ${fmtDate(r.arrivalDate)} was not approved: ${i.reason}`)
    return ok({ requestId: r.id, status: 'rejected' }, 'Request rejected. The resident has been told why.')
  })
}
