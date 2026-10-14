import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { transferRequest } from '@/server/db/schema.stays'
import { audit } from '@/server/audit'
import { runCommand } from '@/server/command/run'
import type { RequestContext } from '@/server/command/context'
import { fail, ok, type Result } from '@/server/command/result'
import { decide } from '@/server/policy'
import { notify } from '@/server/notify'
import { authorizeAny, authorizeDecision, idSchema, loadStaysLocked, noteSchema, notInvolved, reasonSchema } from './shared'
import { checkDestination, consentVia, involvedNames, loadTransfer, type TransferRow } from './transferShared'

const optionalId = idSchema.nullish().transform(v => v ?? null)

/* ---------------- swap consent ---------------- */

export const consentInput = z.object({
  id: idSchema,
  /** Needed when an Accommodation Admin records consent on an occupant's behalf; an occupant's own consent is inferred. */
  party: z.enum(['a', 'b']).nullish().transform(v => v ?? null),
  via: consentVia.nullish().transform(v => v ?? null),
  note: noteSchema,
})
export type SwapConsentInput = z.infer<typeof consentInput>

/** Each occupant of a swap must agree. They confirm in the app, or an Accommodation Admin records how they agreed (in person, by phone, in writing). */
export function recordSwapConsent(rc: RequestContext, i: SwapConsentInput): Promise<Result<{ id: string; party: 'a' | 'b'; consentComplete: boolean }>> {
  return runCommand(rc, async c => {
    const t = await loadTransfer(c.tx, i.id, true)
    if (!t || t.kind !== 'swap') return fail.notFound()
    const me = c.actor.staffId
    const occupantParty = me && c.actor.role === 'Res' ? (me === t.staffId ? 'a' : me === t.otherStaffId ? 'b' : null) : null
    let party: 'a' | 'b'
    let via: NonNullable<TransferRow['consentAVia']>
    if (occupantParty) {
      party = occupantParty
      via = 'in_app'
    } else {
      const denied = authorizeAny(c, ['transfers_swaps.approve'], { siteId: t.siteId })
      if (denied) return denied
      if (!i.party) return fail.invalid('Say whose consent this is', { party: 'Choose the first or the second resident' })
      if (!i.via) return fail.invalid('Say how they agreed', { via: 'In person, by phone or in writing' })
      party = i.party
      via = i.via
    }
    if (t.status !== 'requested') return fail.conflict(`This swap is ${t.status}, so consent can no longer be recorded`, 'Accommodation Admin', 'Raise a new swap if it is still wanted')

    const already = party === 'a' ? t.consentAAt : t.consentBAt
    const other = party === 'a' ? t.consentBAt : t.consentAAt
    if (already) return ok({ id: t.id, party, consentComplete: !!other }, 'Consent was already recorded.')
    const set = party === 'a'
      ? { consentAAt: c.now, consentABy: c.user.id, consentAVia: via, consentANote: i.note }
      : { consentBAt: c.now, consentBBy: c.user.id, consentBVia: via, consentBNote: i.note }
    await c.tx.update(transferRequest).set(set).where(eq(transferRequest.id, t.id))
    await audit(c, { action: 'stays.swap.consent', entityType: 'transfer_request', entityId: t.id, siteId: t.siteId, reason: i.note ?? undefined, after: { party, via, bothConsented: !!other } })
    if (other) {
      await notify(c.tx, { dedupeKey: `transfer:${t.id}:consent_complete`, kind: 'swap.consent_complete', to: { role: 'AA', siteId: t.siteId }, ref: { type: 'transfer_request', id: t.id }, text: 'Both residents have agreed to the bed swap. It is ready for your decision.' })
    }
    return ok({ id: t.id, party, consentComplete: !!other }, other ? 'Both residents have now agreed.' : 'Consent recorded. The other resident still needs to agree.')
  })
}

/* ---------------- approve (AA; D-26: never the person it is about, nor who raised it) ---------------- */

export const approveInput = z.object({
  id: idSchema,
  /** Required when the request said "any suitable bed", or to choose a different bed after a failed execution. */
  destinationBedId: optionalId,
  note: noteSchema,
})
export type ApproveTransferInput = z.infer<typeof approveInput>

export function approveTransfer(rc: RequestContext, i: ApproveTransferInput): Promise<Result<{ id: string; status: 'approved' }>> {
  return runCommand(rc, async c => {
    const t = await loadTransfer(c.tx, i.id, true)
    if (!t) return fail.notFound()
    const denied = await authorizeDecision(c, { kind: 'transfer', siteId: t.siteId, since: t.failedAt && t.failedAt > t.createdAt ? t.failedAt : t.createdAt })
    if (denied) return denied
    const self = notInvolved(c, [t.staffId, t.otherStaffId, t.requestedByStaffId], `approve this ${t.kind}`)
    if (self) return self
    if (t.status !== 'requested' && t.status !== 'failed') {
      return fail.conflict(`This ${t.kind} is already ${t.status}`, 'Accommodation Admin', t.status === 'approved' ? 'Reception executes it' : 'Raise a new request if it is still wanted')
    }

    const stays = await loadStaysLocked(c.tx, [t.stayId, ...(t.otherStayId ? [t.otherStayId] : [])])
    const a = stays.find(x => x.id === t.stayId)
    const b = stays.find(x => x.id === t.otherStayId)
    if (!a || a.status !== 'active' || a.bedId !== t.fromBedId || (t.kind === 'swap' && (!b || b.status !== 'active' || b.bedId !== t.toBedId))) {
      return fail.conflict(`The stay changed since this ${t.kind} was requested`, 'Accommodation Admin', 'Cancel it and raise a new request', { reason: 'stale' })
    }

    let toBedId = t.toBedId
    if (t.kind === 'swap') {
      const missing = [t.consentAAt ? null : 'the first resident', t.consentBAt ? null : 'the second resident'].filter(Boolean)
      if (missing.length) {
        return fail.conflict(`A swap needs both residents to agree; ${missing.join(' and ')} has not yet`, 'The resident, or the Accommodation Admin recording it', 'Ask them to confirm in the app, or record how they agreed', { reason: 'consent_missing' })
      }
    } else {
      toBedId = i.destinationBedId ?? t.toBedId
      if (!toBedId) return fail.invalid('Choose the destination bed', { destinationBedId: 'This request said "any suitable bed": pick one' })
      const bad = await checkDestination(c.tx, { siteId: t.siteId, currentBedId: t.fromBedId }, toBedId)
      if (bad) return bad
    }

    await c.tx.update(transferRequest).set({
      status: 'approved', toBedId, decidedBy: c.user.id, decidedAt: c.now, decisionReason: i.note,
    }).where(eq(transferRequest.id, t.id))
    await audit(c, {
      action: `stays.${t.kind}.approved`, entityType: 'transfer_request', entityId: t.id, siteId: t.siteId, reason: i.note ?? undefined,
      before: { status: t.status, toBedId: t.toBedId }, after: { status: 'approved', toBedId },
    })
    const names = await involvedNames(c.tx, t)
    const round = t.failureCount
    await notify(c.tx, { dedupeKey: `transfer:${t.id}:approved:${round}`, kind: `${t.kind}.approved`, to: { role: 'Rec', siteId: t.siteId }, ref: { type: 'transfer_request', id: t.id }, text: `${t.kind === 'swap' ? 'Bed swap' : 'Transfer'} approved for ${names}. Please carry it out when the resident is ready.`, critical: false })
    for (const staffId of [t.staffId, t.otherStaffId]) {
      if (staffId) await notify(c.tx, { dedupeKey: `transfer:${t.id}:approved:${round}:${staffId}`, kind: `${t.kind}.approved`, to: { staffId }, ref: { type: 'transfer_request', id: t.id }, text: `Your bed ${t.kind === 'swap' ? 'swap' : 'transfer'} was approved. Reception will arrange the move.` })
    }
    return ok({ id: t.id, status: 'approved' as const }, `${t.kind === 'swap' ? 'Swap' : 'Transfer'} approved. Reception can now carry it out.`)
  })
}

/* ---------------- reject ---------------- */

export const rejectInput = z.object({ id: idSchema, reason: reasonSchema })
export type RejectTransferInput = z.infer<typeof rejectInput>

/** An Accommodation Admin (or backup) rejects with a reason; a resident in a swap can decline their part before it is approved. */
export function rejectTransfer(rc: RequestContext, i: RejectTransferInput): Promise<Result<{ id: string; status: 'rejected' }>> {
  return runCommand(rc, async c => {
    const t = await loadTransfer(c.tx, i.id, true)
    if (!t) return fail.notFound()
    const me = c.actor.staffId
    const occupantDeclines = t.kind === 'swap' && c.actor.role === 'Res' && !!me && [t.staffId, t.otherStaffId].includes(me)
      && decide(c.actor, 'transfers_swaps.request', { siteId: t.siteId, ownerStaffId: me }).allowed
    if (!occupantDeclines) {
      const denied = await authorizeDecision(c, { kind: 'transfer', siteId: t.siteId, since: t.failedAt && t.failedAt > t.createdAt ? t.failedAt : t.createdAt })
      if (denied) return denied
      const self = notInvolved(c, [t.staffId, t.otherStaffId, t.requestedByStaffId], `reject this ${t.kind}`)
      if (self) return self
    }
    if (!['requested', 'approved', 'failed'].includes(t.status)) return fail.conflict(`This ${t.kind} is already ${t.status}`, 'Accommodation Admin', 'Nothing more to do')
    if (occupantDeclines && t.status !== 'requested') return fail.conflict('The swap is already approved', 'Accommodation Admin', 'Ask the Accommodation Admin to cancel it')

    await c.tx.update(transferRequest).set({ status: 'rejected', decidedBy: c.user.id, decidedAt: c.now, decisionReason: i.reason }).where(eq(transferRequest.id, t.id))
    await audit(c, { action: `stays.${t.kind}.rejected`, entityType: 'transfer_request', entityId: t.id, siteId: t.siteId, reason: i.reason, before: { status: t.status }, after: { status: 'rejected', byOccupant: occupantDeclines } })
    for (const staffId of [t.staffId, t.otherStaffId, t.requestedByStaffId]) {
      if (staffId) await notify(c.tx, { dedupeKey: `transfer:${t.id}:rejected:${staffId}`, kind: `${t.kind}.rejected`, to: { staffId }, ref: { type: 'transfer_request', id: t.id }, text: `The bed ${t.kind} was not approved: ${i.reason}` })
    }
    return ok({ id: t.id, status: 'rejected' as const }, `${t.kind === 'swap' ? 'Swap' : 'Transfer'} rejected. Nobody was moved.`)
  })
}
