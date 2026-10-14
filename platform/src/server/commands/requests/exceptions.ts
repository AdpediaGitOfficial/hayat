/**
 * The Policy Approver exception workflow (D-25, AT-006, AT-007):
 *   Accommodation Admin finds a bed is refused for gender or grade  ->  requestException  (request: submitted -> pending_approval)
 *   Policy Approver decides                                         ->  grantException   (request: back to submitted, exception rows written)
 *                                                                       declineException (request: back to submitted, ask declined)
 *   The Accommodation Admin then picks a bed and approves; the use is recorded against the exception.
 * Reason and evidence are mandatory and every use is reported (docs/APPROVALS.md). Nothing here decides on a timer.
 */
import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { accommodationRequest, bed } from '@/server/db/schema'
import { eligibilityException } from '@/server/db/schema.alloc'
import { requestExceptionAsk, type ExceptionKind } from '@/server/db/schema.requests'
import { audit } from '@/server/audit'
import { authorize, notSelf } from '@/server/command/authorize'
import { runCommand } from '@/server/command/run'
import type { CommandContext, RequestContext } from '@/server/command/context'
import { fail, failure, ok, type Failure, type Result } from '@/server/command/result'
import { checkEligibility } from '@/server/eligibility'
import { notify } from '@/server/notify'
import { fmtDate } from '@/domain/time'
import { decisionSod, idSchema, loadRequest, loadStaff, reasonSchema, snapRequest, wrongState, type RequestRow } from './shared'

const kindSchema = z.enum(['gender', 'grade'], { error: 'Choose gender or grade' })

/* ---------------- the Accommodation Admin asks ---------------- */

export const askInput = z.object({
  requestId: idSchema,
  reason: reasonSchema,
  /** The bed the admin would like to use: the refusal for that bed says which rules need an exception. */
  bedId: idSchema.optional(),
  kinds: z.array(kindSchema).max(2).optional(),
})
export type RequestExceptionInput = z.infer<typeof askInput>

export function requestException(rc: RequestContext, i: RequestExceptionInput): Promise<Result<{ requestId: string; askId: string; kinds: ExceptionKind[] }>> {
  return runCommand(rc, async c => {
    const peek = await loadRequest(c.tx, i.requestId)
    if (!peek) return fail.notFound()
    const denied = authorize(c, 'requests_waitlist.approve', { siteId: peek.siteId })
    if (denied) return denied
    const sod = decisionSod(c, peek, 'ask for an exception on this request')
    if (sod) return sod

    const r = await loadRequest(c.tx, i.requestId, true)
    if (!r) return fail.notFound()
    if (r.status === 'pending_approval') {
      const [open] = await c.tx.select().from(requestExceptionAsk).where(and(eq(requestExceptionAsk.requestId, r.id), eq(requestExceptionAsk.status, 'asked')))
      if (open && open.askedBy === c.user.id) return ok({ requestId: r.id, askId: open.id, kinds: open.kinds }, 'Already asked.') // a retried call
      return wrongState(r, 'sent for an exception again')
    }
    if (r.status !== 'submitted') return wrongState(r, 'sent for an exception')

    let kinds: ExceptionKind[] = i.kinds ?? []
    if (i.bedId) {
      const [b] = await c.tx.select({ siteId: bed.siteId }).from(bed).where(eq(bed.id, i.bedId))
      if (!b || b.siteId !== r.siteId) return fail.invalid('That bed is not at the requested site', { bedId: 'Choose a bed at the requested site' })
      const e = await checkEligibility(c.tx, r.staffId, i.bedId, c.now, { requestId: r.id })
      if (!e) return fail.notFound()
      if (e.failed.includes('employment')) {
        return failure('conflict', 'This person is not an active employee, so no exception can be granted', { owner: 'Accommodation Admin', next: 'Reject the request, or review the employment status', detail: { reason: 'not_exceptionable' } })
      }
      const needed = e.failed.filter((k): k is ExceptionKind => k === 'gender' || k === 'grade')
      if (needed.length === 0 && e.ok && e.exceptionIds.length === 0) {
        return failure('conflict', 'This person is eligible for that bed, so no exception is needed', { owner: 'Accommodation Admin', next: 'Approve the request with that bed', detail: { reason: 'no_exception_needed' } })
      }
      if (!i.kinds) kinds = needed
    }
    if (kinds.length === 0) return fail.invalid('Say which rule needs an exception', { kinds: 'Choose gender, grade or both, or pick the bed that was refused' })

    const [ask] = await c.tx.insert(requestExceptionAsk).values({ requestId: r.id, siteId: r.siteId, askedBy: c.user.id, kinds, bedId: i.bedId ?? null, reason: i.reason }).returning()
    await c.tx.update(accommodationRequest).set({ status: 'pending_approval' }).where(eq(accommodationRequest.id, r.id))
    const who = (await loadStaff(c.tx, r.staffId))?.fullName ?? 'a resident'
    await audit(c, { action: 'requests.exception.requested', entityType: 'request', entityId: r.id, siteId: r.siteId, reason: i.reason, before: snapRequest(r), after: { status: 'pending_approval', askId: ask.id, kinds, bedId: i.bedId ?? null } })
    await notify(c.tx, {
      dedupeKey: `request:${r.id}:exception:${ask.id}:asked`, kind: 'exception.requested', to: { role: 'PolicyApprover', siteId: r.siteId }, ref: { type: 'request', id: r.id },
      text: `Exception needed (${kinds.join(' and ')}) for ${who}, arriving ${fmtDate(r.arrivalDate)}: ${i.reason}`,
    })
    return ok({ requestId: r.id, askId: ask.id, kinds }, 'Sent to a Policy Approver. The request waits for their decision.')
  })
}

/* ---------------- the Policy Approver decides ---------------- */

/** A Policy Approver is never the request's subject, its submitter or the one who asked for the exception (D-25, D-26). */
async function loadForPolicyApprover(c: CommandContext, id: string, what: string): Promise<Failure | { peek: RequestRow }> {
  const peek = await loadRequest(c.tx, id)
  if (!peek) return fail.notFound()
  const denied = authorize(c, 'requests_waitlist.approve_exception', { siteId: peek.siteId })
  if (denied) return denied
  const self = notSelf(c, peek.staffId, what)
  if (self) return self
  if (peek.submittedBy === c.user.id) return fail.sod(`You filed this request, so you cannot ${what}`, 'A different Policy Approver decides it (D-26)')
  // The one who ASKED for the exception does not decide it either (maker-checker): an Accommodation Admin who also holds the Policy Approver capability.
  const [open] = await c.tx.select({ askedBy: requestExceptionAsk.askedBy }).from(requestExceptionAsk)
    .where(and(eq(requestExceptionAsk.requestId, id), eq(requestExceptionAsk.status, 'asked'))).limit(1)
  if (open?.askedBy === c.user.id) return fail.sod(`You asked for this exception, so you cannot ${what}`, 'A different Policy Approver decides it (D-26)')
  return { peek }
}

export const grantInput = z.object({
  requestId: idSchema,
  kinds: z.array(kindSchema).min(1, 'Choose at least one rule').max(2),
  reason: reasonSchema,
  evidence: z.string().trim().min(3, 'Evidence is required (what supports this exception?)').max(1000, 'At most 1000 characters'),
})
export type GrantExceptionInput = z.infer<typeof grantInput>

export function grantException(rc: RequestContext, i: GrantExceptionInput): Promise<Result<{ requestId: string; exceptionIds: string[]; status: string }>> {
  return runCommand(rc, async c => {
    const p = await loadForPolicyApprover(c, i.requestId, 'grant an exception')
    if ('ok' in p) return p
    const r = await loadRequest(c.tx, i.requestId, true)
    if (!r) return fail.notFound()
    if (r.status !== 'pending_approval' && r.status !== 'submitted') return wrongState(r, 'given an exception')

    const kinds = [...new Set(i.kinds)]
    const existing = await c.tx.select({ id: eligibilityException.id, kind: eligibilityException.kind }).from(eligibilityException)
      .where(and(eq(eligibilityException.requestId, r.id), isNull(eligibilityException.revokedAt), inArray(eligibilityException.kind, kinds)))
    const have = new Set(existing.map(e => e.kind))
    const missing = kinds.filter(k => !have.has(k))
    if (missing.length === 0) return ok({ requestId: r.id, exceptionIds: existing.map(e => e.id), status: r.status }, 'Already granted.') // a retried call

    const created = await c.tx.insert(eligibilityException).values(missing.map(kind => ({
      staffId: r.staffId, kind, siteId: r.siteId, requestId: r.id, grantedBy: c.user.id, reason: i.reason, evidence: i.evidence,
    }))).returning({ id: eligibilityException.id })

    await c.tx.update(requestExceptionAsk).set({ status: 'granted', decidedBy: c.user.id, decidedAt: c.now, decisionReason: i.reason })
      .where(and(eq(requestExceptionAsk.requestId, r.id), eq(requestExceptionAsk.status, 'asked')))
    // Back to the Accommodation Admin, who picks the bed. The exception is scoped to THIS request.
    await c.tx.update(accommodationRequest).set({ status: 'submitted', exceptionBy: c.user.id }).where(eq(accommodationRequest.id, r.id))
    await audit(c, {
      action: 'requests.exception.granted', entityType: 'request', entityId: r.id, siteId: r.siteId, reason: i.reason,
      before: { status: r.status }, after: { status: 'submitted', kinds: missing, exceptionIds: created.map(x => x.id), evidence: i.evidence },
    })
    await notify(c.tx, {
      dedupeKey: `request:${r.id}:exception-granted:${created[0].id}`, kind: 'exception.granted', to: { role: 'AA', siteId: r.siteId }, ref: { type: 'request', id: r.id },
      text: `A Policy Approver granted the ${missing.join(' and ')} exception for a request arriving ${fmtDate(r.arrivalDate)}. Choose a bed and approve.`,
    })
    return ok({ requestId: r.id, exceptionIds: [...existing.map(e => e.id), ...created.map(x => x.id)], status: 'submitted' }, 'Exception granted. The Accommodation Admin can now choose a bed.')
  })
}

export const declineInput = z.object({ requestId: idSchema, reason: reasonSchema })

export function declineException(rc: RequestContext, i: z.infer<typeof declineInput>): Promise<Result<{ requestId: string; status: string }>> {
  return runCommand(rc, async c => {
    const p = await loadForPolicyApprover(c, i.requestId, 'decline an exception')
    if ('ok' in p) return p
    const r = await loadRequest(c.tx, i.requestId, true)
    if (!r) return fail.notFound()
    if (r.status !== 'pending_approval') {
      const [last] = await c.tx.select().from(requestExceptionAsk).where(eq(requestExceptionAsk.requestId, r.id)).orderBy(desc(requestExceptionAsk.createdAt)).limit(1)
      if (r.status === 'submitted' && last?.status === 'declined' && last.decidedBy === c.user.id) return ok({ requestId: r.id, status: r.status }, 'Already declined.') // a retried call
      return wrongState(r, 'declined as an exception')
    }
    const [ask] = await c.tx.update(requestExceptionAsk).set({ status: 'declined', decidedBy: c.user.id, decidedAt: c.now, decisionReason: i.reason })
      .where(and(eq(requestExceptionAsk.requestId, r.id), eq(requestExceptionAsk.status, 'asked'))).returning({ id: requestExceptionAsk.id })
    await c.tx.update(accommodationRequest).set({ status: 'submitted' }).where(eq(accommodationRequest.id, r.id))
    await audit(c, { action: 'requests.exception.declined', entityType: 'request', entityId: r.id, siteId: r.siteId, reason: i.reason, before: { status: r.status }, after: { status: 'submitted', askId: ask?.id ?? null } })
    await notify(c.tx, {
      dedupeKey: `request:${r.id}:exception-declined:${ask?.id ?? 'none'}`, kind: 'exception.declined', to: { role: 'AA', siteId: r.siteId }, ref: { type: 'request', id: r.id },
      text: `A Policy Approver declined the exception for a request arriving ${fmtDate(r.arrivalDate)}: ${i.reason}. Choose another bed, send it back, or reject it.`,
    })
    return ok({ requestId: r.id, status: 'submitted' }, 'Exception declined. The request is back with the Accommodation Admin.')
  })
}
