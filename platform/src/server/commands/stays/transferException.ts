/**
 * A Policy Approver exception for ONE transfer or swap destination (S-21, P-10). PROPOSED, pending client sign-off: behind the setting
 * `transfers.exception_path`; with it off nothing here runs and a destination that fails gender or grade is simply refused, as before.
 *
 * It follows the request exception of WP-D (D-25): reason AND evidence are mandatory, never the person moving nor the person who raised
 * the move (D-26), the scope is the DESTINATION site, and every use is recorded by executeTransfer (`recordExceptionUse`). What differs:
 *  - the exception row carries `transfer_request_id`, so it counts for THIS transfer only. It does not apply to another transfer, a
 *    request or a check-in of the same person (checkEligibility without that transfer id ignores it);
 *  - the password of the Policy Approver is re-confirmed inside the command (D-03, `confirmPassword`), because granting an exception
 *    is a high-risk decision;
 *  - a left employee is never exceptionable (the rule is evaluated by checkEligibility, which marks `employment` as not waivable).
 *
 * "Waiting for a Policy Approver exception" is DERIVED, not stored: an open transfer (requested, approved or failed) with a chosen
 * destination bed that fails gender or grade and for which no exception exists yet. A grant makes the destination pass, so the state
 * disappears by itself; a decline is remembered per person and bed (`transfer_exception_decision`) so the same question is not put to
 * the Policy Approver again for the same bed. Nothing here approves, rejects or moves anyone, and no timer decides it.
 */
import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { staffProfile } from '@/server/db/schema'
import { eligibilityException } from '@/server/db/schema.alloc'
import { transferExceptionDecision } from '@/server/db/schema.stays'
import type { Db } from '@/server/db/client'
import { audit } from '@/server/audit'
import { authorize } from '@/server/command/authorize'
import { decide } from '@/server/policy'
import { runCommand } from '@/server/command/run'
import type { CommandContext, RequestContext } from '@/server/command/context'
import { fail, failure, ok, type Failure, type Result } from '@/server/command/result'
import { confirmPassword } from '@/server/auth/reauth'
import { checkEligibility } from '@/server/eligibility'
import { notify } from '@/server/notify'
import { bedLabel, idSchema, notInvolved, reasonSchema, staffName } from './shared'
import { exceptionPathOn, loadTransfer, policyNotInForce, siteNameOf, type TransferRow } from './transferShared'

export type ExceptionKind = 'gender' | 'grade'
const kindSchema = z.enum(['gender', 'grade'], { error: 'Choose gender or grade' })
type Reader = Pick<Db, 'select'>

export const OPEN_FOR_EXCEPTION: TransferRow['status'][] = ['requested', 'approved', 'failed']

/** One person who would move, the bed they would move into and the site that owns that bed (the scope of the decision). */
export interface Mover { staffId: string; bedId: string | null; siteId: string; party: 'first' | 'second' }

/** A transfer has one mover; a swap has two, each judged against the bed of the other and the site of that bed. */
export function moversOf(t: Pick<TransferRow, 'kind' | 'staffId' | 'otherStaffId' | 'toBedId' | 'fromBedId' | 'siteId' | 'destinationSiteId'>): Mover[] {
  const first: Mover = { staffId: t.staffId, bedId: t.toBedId, siteId: t.destinationSiteId, party: 'first' }
  if (t.kind === 'transfer' || !t.otherStaffId) return [first]
  return [first, { staffId: t.otherStaffId, bedId: t.fromBedId, siteId: t.siteId, party: 'second' }]
}

export interface ExceptionNeed {
  staffId: string
  bedId: string
  siteId: string
  party: Mover['party']
  /** waiting: a Policy Approver can decide it. declined: they did, for this bed. blocked: not waivable (a left employee). */
  state: 'waiting' | 'declined' | 'blocked'
  failed: ExceptionKind[]
  reasons: string[]
  declinedReason?: string
}

/**
 * What each mover of an open transfer still needs, judged now with the exceptions already granted for THIS transfer. Empty when
 * everyone passes (or nobody has a destination bed yet). It reports the failures whatever the setting says; the approval source, the
 * screens and the commands check `transfers.exception_path` themselves.
 */
export async function exceptionNeeds(q: Reader, t: TransferRow, now: Date): Promise<ExceptionNeed[]> {
  if (!OPEN_FOR_EXCEPTION.includes(t.status)) return []
  const out: ExceptionNeed[] = []
  for (const m of moversOf(t)) {
    if (!m.bedId) continue
    const e = await checkEligibility(q, m.staffId, m.bedId, now, { transferId: t.id })
    if (!e || e.ok) continue
    const failed = e.failed.filter((k): k is ExceptionKind => k === 'gender' || k === 'grade')
    if (!e.exceptionable) { out.push({ staffId: m.staffId, bedId: m.bedId, siteId: m.siteId, party: m.party, state: 'blocked', failed, reasons: e.reasons }); continue }
    const [declined] = await q.select({ reason: transferExceptionDecision.reason }).from(transferExceptionDecision)
      .where(and(eq(transferExceptionDecision.transferRequestId, t.id), eq(transferExceptionDecision.staffId, m.staffId), eq(transferExceptionDecision.bedId, m.bedId)))
      .orderBy(desc(transferExceptionDecision.createdAt)).limit(1)
    out.push({ staffId: m.staffId, bedId: m.bedId, siteId: m.siteId, party: m.party, state: declined ? 'declined' : 'waiting', failed, reasons: e.reasons, declinedReason: declined?.reason })
  }
  return out
}

/* ---------------- the Policy Approver decides ---------------- */

const evidenceSchema = z.string().trim().min(3, 'Evidence is required (what supports this exception?)').max(1000, 'At most 1000 characters')
const optionalId = idSchema.nullish().transform(v => v ?? null)

interface Target { t: TransferRow; mover: Mover }

/**
 * The common start of grant and decline, in the order that leaks least: the record is found, the actor needs the action AT THE
 * DESTINATION SITE of the person concerned (otherwise "not found"), the proposal must be in force, the actor must be independent of
 * everyone involved (D-26), and only then is the password re-confirmed (D-03). Nothing has been written when this returns.
 */
async function open(c: CommandContext, i: { transferId: string; staffId: string | null; confirmPassword?: string }, what: string): Promise<Failure | Target> {
  const peek = await loadTransfer(c.tx, i.transferId, false)
  if (!peek) return fail.notFound()
  const movers = moversOf(peek)
  let mover: Mover | undefined
  if (i.staffId) {
    mover = movers.find(m => m.staffId === i.staffId)
    if (!mover) return fail.invalid('That person is not part of this move', { staffId: 'Choose the person who would move' })
  } else if (movers.length === 1) mover = movers[0]
  else {
    // A swap: say whose exception it is, unless only one of them needs one. Someone with no business at either site learns nothing.
    if (!movers.some(m => decide(c.actor, 'requests_waitlist.approve_exception', { siteId: m.siteId }).allowed)) {
      return authorize(c, 'requests_waitlist.approve_exception', { siteId: movers[0].siteId }) ?? fail.notFound()
    }
    const needing = (await exceptionNeeds(c.tx, peek, c.now)).filter(n => n.state === 'waiting' && decide(c.actor, 'requests_waitlist.approve_exception', { siteId: n.siteId }).allowed)
    if (needing.length !== 1) return fail.invalid('Say whose exception this is', { staffId: 'Choose which of the two residents' })
    mover = movers.find(m => m.staffId === needing[0].staffId)
  }
  if (!mover) return fail.notFound()
  const denied = authorize(c, 'requests_waitlist.approve_exception', { siteId: mover.siteId })
  if (denied) return denied
  if (!(await exceptionPathOn(c.tx, mover.siteId))) {
    return policyNotInForce('P-10', `A Policy Approver cannot ${what} for a transfer`, { owner: 'Super Admin', next: 'The Policy Approver exception for transfers is proposed and not in force. A Super Admin can switch it on in System configuration only after Grand Hyatt signs it off; until then choose an eligible bed' })
  }
  const sod = notInvolved(c, [peek.staffId, peek.otherStaffId, peek.requestedByStaffId], what)
  if (sod) return sod
  if (peek.requestedBy && peek.requestedBy === c.user.id) return fail.sod(`You raised this move, so you cannot ${what}`, 'A different Policy Approver decides it (D-26)')
  const again = await confirmPassword(c, i.confirmPassword)
  if (again) return again
  const t = await loadTransfer(c.tx, i.transferId, true)
  if (!t) return fail.notFound()
  return { t, mover }
}
const isFailure = (x: Failure | Target): x is Failure => 'ok' in x

const notOpen = (t: TransferRow, what: string) => failure('conflict', `This ${t.kind} is ${t.status === 'executed' ? 'already done' : t.status}, so it cannot be ${what}`, {
  owner: 'Accommodation Admin', next: 'Raise a new request if the move is still wanted', detail: { reason: 'transfer_not_open', status: t.status },
})

export const grantInput = z.object({
  transferId: idSchema,
  /** A swap has two people: whose exception. Left out = the only one who needs it. */
  staffId: optionalId,
  kinds: z.array(kindSchema).min(1, 'Choose at least one rule').max(2),
  reason: reasonSchema,
  evidence: evidenceSchema,
  confirmPassword: z.string().optional(),
})
export type GrantTransferExceptionInput = z.infer<typeof grantInput>
export interface GrantTransferExceptionOut { transferId: string; staffId: string; exceptionIds: string[] }

export function grantTransferException(rc: RequestContext, i: GrantTransferExceptionInput): Promise<Result<GrantTransferExceptionOut>> {
  return runCommand(rc, async c => {
    const o = await open(c, i, 'grant an exception')
    if (isFailure(o)) return o
    const { t, mover } = o
    if (!OPEN_FOR_EXCEPTION.includes(t.status)) return notOpen(t, 'given an exception')

    const [person] = await c.tx.select({ status: staffProfile.employmentStatus, name: staffProfile.fullName }).from(staffProfile).where(eq(staffProfile.id, mover.staffId)).limit(1)
    if (!person || person.status !== 'active') {
      return failure('conflict', 'This person is not an active employee, so no exception can be granted', { owner: 'Accommodation Admin', next: 'Reject the move, or review the employment status', detail: { reason: 'not_exceptionable' } })
    }
    const kinds = [...new Set(i.kinds)]
    if (mover.bedId) {
      const need = (await exceptionNeeds(c.tx, t, c.now)).find(n => n.staffId === mover.staffId)
      const existing = await heldFor(c, t.id, mover.staffId, kinds)
      if (!need) {
        // Nothing to waive: either they pass already because of an exception (a retried call), or they never needed one.
        if (existing.length === kinds.length) return ok({ transferId: t.id, staffId: mover.staffId, exceptionIds: existing.map(e => e.id) }, 'Already granted.')
        return failure('conflict', 'This person is eligible for that bed, so no exception is needed', { owner: 'Accommodation Admin', next: 'Approve the move', detail: { reason: 'no_exception_needed' } })
      }
      if (need.state === 'blocked') return failure('conflict', `${need.reasons.join('; ')}. No exception can be granted`, { owner: 'Accommodation Admin', next: 'Reject the move, or review the employment status', detail: { reason: 'not_exceptionable' } })
      const notFailing = kinds.filter(k => !need.failed.includes(k) && !existing.some(e => e.kind === k))
      if (notFailing.length > 0) return fail.invalid(`That rule is not failing for this bed: ${notFailing.join(', ')}`, { kinds: `Only ${need.failed.join(' and ')} needs an exception here` })
    }
    const have = new Set((await heldFor(c, t.id, mover.staffId, kinds)).map(e => e.kind))
    const missing = kinds.filter(k => !have.has(k))
    if (missing.length === 0) return ok({ transferId: t.id, staffId: mover.staffId, exceptionIds: (await heldFor(c, t.id, mover.staffId, kinds)).map(e => e.id) }, 'Already granted.')

    const created = await c.tx.insert(eligibilityException).values(missing.map(kind => ({
      staffId: mover.staffId, kind, siteId: mover.siteId, transferRequestId: t.id, grantedBy: c.user.id, reason: i.reason, evidence: i.evidence,
    }))).returning({ id: eligibilityException.id })

    const where = mover.bedId ? await bedLabel(c.tx, mover.bedId) : null
    await audit(c, {
      action: 'stays.transfer.exception.granted', entityType: 'transfer_request', entityId: t.id, siteId: mover.siteId, reason: i.reason,
      before: { status: t.status, exceptions: [...have] },
      after: { kinds: missing, exceptionIds: created.map(x => x.id), evidence: i.evidence, staffId: mover.staffId, bedId: mover.bedId, scope: 'this transfer only', proposal: 'P-10, pending client sign-off' },
    })
    const text = `A Policy Approver recorded the ${missing.join(' and ')} exception for ${person.name}${where ? ` moving to ${where}` : ''}. ${t.status === 'failed' ? 'Approve the move again; ' : 'The move can go ahead; '}the exception counts for this ${t.kind} only.`
    await notify(c.tx, { dedupeKey: `transfer:${t.id}:exception-granted:${created[0].id}`, kind: 'transfer.exception_granted', to: { role: 'AA', siteId: mover.siteId }, ref: { type: 'transfer_request', id: t.id }, text })
    if (t.siteId !== mover.siteId) {
      await notify(c.tx, { dedupeKey: `transfer:${t.id}:exception-granted:${created[0].id}:source`, kind: 'transfer.exception_granted', to: { role: 'AA', siteId: t.siteId }, ref: { type: 'transfer_request', id: t.id }, text })
    }
    return ok({ transferId: t.id, staffId: mover.staffId, exceptionIds: [...(await heldFor(c, t.id, mover.staffId, kinds)).map(e => e.id)] },
      'Exception recorded for this move only. The Accommodation Admin of the destination site can now approve it.')
  })
}

export const declineInput = z.object({ transferId: idSchema, staffId: optionalId, reason: reasonSchema, confirmPassword: z.string().optional() })
export type DeclineTransferExceptionInput = z.infer<typeof declineInput>

export function declineTransferException(rc: RequestContext, i: DeclineTransferExceptionInput): Promise<Result<{ transferId: string; staffId: string }>> {
  return runCommand(rc, async c => {
    const o = await open(c, i, 'decline an exception')
    if (isFailure(o)) return o
    const { t, mover } = o
    if (!OPEN_FOR_EXCEPTION.includes(t.status)) return notOpen(t, 'declined as an exception')
    if (!mover.bedId) return failure('conflict', 'No destination bed has been chosen yet, so there is nothing to decide', { owner: 'Accommodation Admin of the destination site', next: 'They choose a bed; if it needs an exception it comes back here', detail: { reason: 'no_destination' } })

    const need = (await exceptionNeeds(c.tx, t, c.now)).find(n => n.staffId === mover.staffId)
    if (!need) return failure('conflict', 'This person passes the rules for that bed, so there is no exception to decline', { owner: 'Accommodation Admin', next: 'Approve the move', detail: { reason: 'no_exception_needed' } })
    if (need.state === 'declined') return ok({ transferId: t.id, staffId: mover.staffId }, 'Already declined.')
    if (need.state === 'blocked') return failure('conflict', `${need.reasons.join('; ')}. No exception can be granted`, { owner: 'Accommodation Admin', next: 'Reject the move, or review the employment status', detail: { reason: 'not_exceptionable' } })

    const [row] = await c.tx.insert(transferExceptionDecision).values({
      transferRequestId: t.id, staffId: mover.staffId, bedId: mover.bedId, siteId: mover.siteId, decision: 'declined', reason: i.reason, decidedBy: c.user.id,
    }).returning({ id: transferExceptionDecision.id })
    await audit(c, {
      action: 'stays.transfer.exception.declined', entityType: 'transfer_request', entityId: t.id, siteId: mover.siteId, reason: i.reason,
      before: { status: t.status, needs: need.failed }, after: { decisionId: row.id, staffId: mover.staffId, bedId: mover.bedId, proposal: 'P-10, pending client sign-off' },
    })
    const who = await staffName(c.tx, mover.staffId)
    const dest = await siteNameOf(c.tx, mover.siteId)
    await notify(c.tx, {
      dedupeKey: `transfer:${t.id}:exception-declined:${row.id}`, kind: 'transfer.exception_declined', to: { role: 'AA', siteId: mover.siteId }, ref: { type: 'transfer_request', id: t.id },
      text: `A Policy Approver declined the ${need.failed.join(' and ')} exception for ${who} moving into ${dest}: ${i.reason}. Choose another bed, or reject the move.`,
    })
    if (t.requestedByStaffId) {
      await notify(c.tx, {
        dedupeKey: `transfer:${t.id}:exception-declined:${row.id}:requester`, kind: 'transfer.exception_declined', to: { staffId: t.requestedByStaffId }, ref: { type: 'transfer_request', id: t.id },
        text: `The exception needed for the move to ${dest} was declined: ${i.reason}.`,
      })
    }
    return ok({ transferId: t.id, staffId: mover.staffId }, 'Exception declined. The destination Accommodation Admin is told and can choose another bed.')
  })
}

/** The live exceptions of this transfer and person for these kinds. */
async function heldFor(c: CommandContext, transferId: string, staffId: string, kinds: ExceptionKind[]) {
  return c.tx.select({ id: eligibilityException.id, kind: eligibilityException.kind }).from(eligibilityException)
    .where(and(eq(eligibilityException.transferRequestId, transferId), eq(eligibilityException.staffId, staffId), isNull(eligibilityException.revokedAt), inArray(eligibilityException.kind, kinds)))
}
