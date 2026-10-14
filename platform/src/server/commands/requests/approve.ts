import { and, eq, ne } from 'drizzle-orm'
import { z } from 'zod'
import { accommodationRequest, bed, reservation } from '@/server/db/schema'
import { audit } from '@/server/audit'
import { authorize } from '@/server/command/authorize'
import { allocateBed } from '@/server/allocation'
import { recordExceptionUse } from '@/server/eligibility'
import { runCommand } from '@/server/command/run'
import type { CommandContext, RequestContext } from '@/server/command/context'
import { fail, ok, type Failure, type Result } from '@/server/command/result'
import { notify } from '@/server/notify'
import { fmtDate } from '@/domain/time'
import { bedLabel, decisionSod, etaFor, idSchema, loadRequest, notifyRequester, snapRequest, wrongState } from './shared'

export const approveInput = z.object({ requestId: idSchema, bedId: idSchema })
export type ApproveRequestInput = z.infer<typeof approveInput>

export interface ApproveOut {
  requestId: string
  reservationId: string
  bedId: string
  bedLabel: string
  from: string
  /** The departure day, or null for an open-ended permanent stay. */
  to: string | null
  /** Policy Approver exceptions that were needed and used for this reservation. */
  exceptionIds: string[]
  /** True when this was a repeat of a call that had already succeeded: nothing was written again. */
  repeated?: boolean
}

/**
 * Approval = pick the bed and create the reservation, in ONE transaction (D-44). Everything below happens inside the
 * caller's transaction, so a failure anywhere (the bed was just taken, the person is not eligible, the reservation insert
 * fails) rolls the whole thing back: no claim, no reservation, the request is still waiting.
 *
 * `source` is 'request' for a single approval and 'bulk' when bulk allocation confirms a row through this same path, so
 * separation of duties and eligibility apply to both.
 */
export async function approveIn(c: CommandContext, i: ApproveRequestInput & { source: 'request' | 'bulk' }): Promise<Result<ApproveOut>> {
  const peek = await loadRequest(c.tx, i.requestId)
  if (!peek) return fail.notFound()
  const denied = authorize(c, 'requests_waitlist.approve', { siteId: peek.siteId })
  if (denied) return denied
  const sod = decisionSod(c, peek, 'approve this request')
  if (sod) return sod

  // A repeat of a call that already succeeded (a retried click or request) answers the same thing and writes nothing.
  if (peek.status === 'approved' && peek.decidedBy === c.user.id) {
    const [rv] = await c.tx.select().from(reservation).where(and(eq(reservation.requestId, peek.id), ne(reservation.status, 'cancelled'))).limit(1)
    if (rv && rv.bedId === i.bedId) {
      const bl = await bedLabel(c.tx, rv.bedId)
      return ok({ requestId: peek.id, reservationId: rv.id, bedId: rv.bedId, bedLabel: bl?.label ?? '', from: peek.arrivalDate, to: peek.endDate, exceptionIds: [], repeated: true }, 'Already reserved.')
    }
  }

  const r = await loadRequest(c.tx, i.requestId, true)
  if (!r) return fail.notFound()
  if (r.status !== 'submitted') return wrongState(r, 'approved')

  const [b] = await c.tx.select({ id: bed.id, siteId: bed.siteId }).from(bed).where(eq(bed.id, i.bedId))
  if (!b) return fail.invalid('That bed does not exist', { bedId: 'Choose a bed from the list' })
  if (b.siteId !== r.siteId) {
    return fail.invalid('That bed is at a different site from the request', { bedId: 'Choose a bed at the requested site. To change the site, send the request back for changes' })
  }

  const a = await allocateBed(c, { bedId: i.bedId, staffId: r.staffId, from: r.arrivalDate, to: r.endDate ?? undefined, kind: 'reservation', requestId: r.id })
  if (!a.ok) return withRequest(a, r.id)

  const [rv] = await c.tx.insert(reservation).values({
    requestId: r.id, staffId: r.staffId, bedId: i.bedId, claimId: a.data.claimId, eta: etaFor(r.arrivalDate), status: 'reserved',
    source: i.source, stayType: r.stayType, createdBy: c.user.id,
  }).returning({ id: reservation.id })
  await recordExceptionUse(c.tx, a.data.exceptionIds, { for: 'reservation', ref: rv.id, by: c.user.id })

  await c.tx.update(accommodationRequest).set({ status: 'approved', decidedBy: c.user.id, decidedAt: c.now, decisionReason: null }).where(eq(accommodationRequest.id, r.id))
  const bl = await bedLabel(c.tx, i.bedId)
  const label = bl?.label ?? 'a bed'
  const window = `${fmtDate(r.arrivalDate)}${r.endDate ? ` to ${fmtDate(r.endDate)}` : ', open-ended'}`

  await audit(c, {
    action: 'requests.request.approved', entityType: 'request', entityId: r.id, siteId: r.siteId, before: snapRequest(r),
    after: { ...snapRequest(r), status: 'approved', reservationId: rv.id, bedId: i.bedId, claimId: a.data.claimId, exceptionIds: a.data.exceptionIds, source: i.source },
  })
  await audit(c, {
    action: 'requests.reservation.created', entityType: 'reservation', entityId: rv.id, siteId: r.siteId,
    after: { requestId: r.id, staffId: r.staffId, bedId: i.bedId, claimId: a.data.claimId, from: r.arrivalDate, to: r.endDate, source: i.source, exceptionIds: a.data.exceptionIds },
  })
  await notifyRequester(c.tx, r, `request:${r.id}:approved`, 'request.approved', `Your bed is reserved: ${label}, ${window}. Reception will check you in when you arrive.`)
  await notify(c.tx, {
    dedupeKey: `reservation:${rv.id}:created`, kind: 'reservation.created', to: { role: 'Rec', siteId: r.siteId }, ref: { type: 'reservation', id: rv.id },
    text: `Arrival expected ${fmtDate(r.arrivalDate)}: ${label}`,
  })
  return ok({ requestId: r.id, reservationId: rv.id, bedId: i.bedId, bedLabel: label, from: r.arrivalDate, to: r.endDate, exceptionIds: a.data.exceptionIds }, `Reserved ${label}.`)
}

/** allocateBed's refusal, with the request attached, so the screen knows which request to offer the exception route for. */
function withRequest(f: Failure, requestId: string): Failure {
  const d = (f.detail && typeof f.detail === 'object' ? f.detail : {}) as Record<string, unknown>
  const needsException = d.reason === 'not_eligible' && d.exceptionable === true
  return {
    ...f,
    detail: { ...d, requestId, ...(needsException ? { policyApproverException: true, exceptionKinds: (d.failed as string[] | undefined)?.filter(k => k === 'gender' || k === 'grade') ?? [] } : {}) },
    next: needsException ? 'Ask a Policy Approver for an exception on this request, or choose a bed that suits the person' : f.next,
  }
}

export function approveRequest(rc: RequestContext, i: ApproveRequestInput): Promise<Result<ApproveOut>> {
  return runCommand(rc, c => approveIn(c, { ...i, source: 'request' }))
}
