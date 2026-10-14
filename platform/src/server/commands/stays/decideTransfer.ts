import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { transferRequest } from '@/server/db/schema.stays'
import { audit } from '@/server/audit'
import { runCommand } from '@/server/command/run'
import type { CommandContext, RequestContext } from '@/server/command/context'
import { fail, ok, type Result } from '@/server/command/result'
import { decide } from '@/server/policy'
import { notify } from '@/server/notify'
import { authorizeAny, bedLabel, idSchema, loadStaysLocked, noteSchema, notInvolved, reasonSchema, staffName } from './shared'
import {
  checkDestination, checkEligibleAt, consentVia, exceptionAnswer, exceptionPathOn, involvedNames, isCrossSite, isFailure, loadTransfer, sideAuthority, siteNameOf, waitingForApproval, type TransferRow,
} from './transferShared'
import { exceptionNeeds } from './transferException'

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
      // An Accommodation Admin of either site may record how an occupant agreed (a cross-site swap has an occupant at each).
      const denied = authorizeAny(c, ['transfers_swaps.approve'], { siteId: t.siteId })
      if (denied && (!isCrossSite(t) || authorizeAny(c, ['transfers_swaps.approve'], { siteId: t.destinationSiteId }))) return denied
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
      if (isCrossSite(t)) {
        await notify(c.tx, { dedupeKey: `transfer:${t.id}:consent_complete:destination`, kind: 'swap.consent_complete', to: { role: 'AA', siteId: t.destinationSiteId }, ref: { type: 'transfer_request', id: t.id }, text: 'Both residents have agreed to the bed swap. It is ready for your decision.' })
      }
    }
    return ok({ id: t.id, party, consentComplete: !!other }, other ? 'Both residents have now agreed.' : 'Consent recorded. The other resident still needs to agree.')
  })
}

/* ---------------- approve (AA; D-26: never the person it is about, nor who raised it) ---------------- */

export const approveInput = z.object({
  id: idSchema,
  /**
   * Required when the request said "any suitable bed", or to choose a different bed after a failed execution. The bed is chosen by the
   * Accommodation Admin of the DESTINATION site (D-104): whoever gives only the source key leaves it alone.
   */
  destinationBedId: optionalId,
  note: noteSchema,
  /**
   * P-10 (proposed, pending client sign-off): the chosen destination bed fails a gender or grade rule of the destination site. Record the
   * bed and wait for a Policy Approver's exception instead of refusing. Explicit, never assumed; the destination key is NOT given meanwhile.
   */
  askException: z.boolean().optional(),
})
export type ApproveTransferInput = z.infer<typeof approveInput>
export interface ApproveTransferOut {
  id: string
  /** 'approved' once both keys are given; otherwise the request stays as it was (requested or failed) and waits for the other site. */
  status: 'approved' | 'requested' | 'failed'
  keys: { source: boolean; destination: boolean }
  /** Who still has to approve, in plain words (null when nobody). */
  waitingFor: string | null
  /** True while the destination bed needs a Policy Approver's exception (P-10, proposed, pending client sign-off). */
  waitingForException?: boolean
}

export function approveTransfer(rc: RequestContext, i: ApproveTransferInput): Promise<Result<ApproveTransferOut>> {
  return runCommand<ApproveTransferOut>(rc, async c => {
    const t = await loadTransfer(c.tx, i.id, true)
    if (!t) return fail.notFound()
    const sides = await sideAuthority(c, t)
    if (isFailure(sides)) return sides
    const self = notInvolved(c, [t.staffId, t.otherStaffId, t.requestedByStaffId], `approve this ${t.kind}`)
    if (self) return self
    // D-109: whoever raised it never approves it, whatever role they hold (also when the raiser has no staff record to compare).
    if (t.requestedBy && t.requestedBy === c.user.id) return fail.sod(`You cannot approve this ${t.kind}: you raised it`, 'An independent approver must do this (D-26, D-109)')
    if (t.status !== 'requested' && t.status !== 'failed') {
      return fail.conflict(`This ${t.kind} is already ${t.status}`, 'Accommodation Admin', t.status === 'approved' ? 'Reception executes it' : 'Raise a new request if it is still wanted')
    }
    const crossSite = isCrossSite(t)

    const stays = await loadStaysLocked(c.tx, [t.stayId, ...(t.otherStayId ? [t.otherStayId] : [])])
    const a = stays.find(x => x.id === t.stayId)
    const b = stays.find(x => x.id === t.otherStayId)
    if (!a || a.status !== 'active' || a.bedId !== t.fromBedId || (t.kind === 'swap' && (!b || b.status !== 'active' || b.bedId !== t.toBedId))) {
      return fail.conflict(`The stay changed since this ${t.kind} was requested`, 'Accommodation Admin', 'Cancel it and raise a new request', { reason: 'stale' })
    }

    // Which keys does this decision give? Everything the actor may give that is still missing (one person holding both sites gives both).
    const giveSource = sides.source && !t.sourceApprovedAt
    const giveDestination = sides.destination && !t.destinationApprovedAt
    if (!giveSource && !giveDestination) {
      const waiting = await waitingForApproval(c.tx, t)
      return fail.conflict(
        `You have already approved your side of this ${t.kind}${waiting ? `; it is waiting for ${waiting.text}` : ''}`,
        waiting?.owner ?? 'Reception', waiting ? 'They approve it from their approvals inbox or the transfers page' : 'Reception carries it out', { reason: 'already_approved_by_you' })
    }

    let toBedId = t.toBedId
    let exceptionWait = false
    if (t.kind === 'swap') {
      const missing = [t.consentAAt ? null : 'the first resident', t.consentBAt ? null : 'the second resident'].filter(Boolean)
      if (missing.length) {
        return fail.conflict(`A swap needs both residents to agree; ${missing.join(' and ')} has not yet`, 'The resident, or the Accommodation Admin recording it', 'Ask them to confirm in the app, or record how they agreed', { reason: 'consent_missing' })
      }
      // P-10 (proposed, pending client sign-off): a swap whose destination still needs a Policy Approver's exception is not approved
      // before that is decided: it would only fail at execution. With the setting off nothing changes.
      if (await exceptionPathOn(c.tx, t.destinationSiteId)) {
        const blocked = (await exceptionNeeds(c.tx, t, c.now)).find(n => n.state !== 'blocked')
        if (blocked) {
          return fail.conflict(blocked.state === 'declined'
            ? `A Policy Approver declined the exception this swap needs: ${blocked.declinedReason ?? ''}`.trim()
            : 'This swap is waiting for a Policy Approver exception (gender or grade rule of the other site)',
          'Policy Approver', blocked.state === 'declined' ? 'Reject the swap, or withdraw it' : 'The Policy Approver of that site decides it from their approvals inbox', { reason: blocked.state === 'declined' ? 'exception_declined' : 'waiting_for_exception' })
        }
      }
    } else if (giveDestination) {
      toBedId = i.destinationBedId ?? t.toBedId
      if (!toBedId) return fail.invalid('Choose the destination bed', { destinationBedId: 'This request said "any suitable bed": pick one' })
      const bad = await checkDestination(c.tx, { siteId: t.destinationSiteId, currentBedId: t.fromBedId }, toBedId)
      if (bad) return bad
      if (crossSite) {
        // An exception granted for THIS transfer counts (P-10, proposed, pending client sign-off).
        const ineligible = await checkEligibleAt(c, t.staffId, toBedId, { transferId: t.id })
        if (ineligible) {
          const stop = exceptionAnswer(ineligible, i.askException)
          if (stop) return stop
          exceptionWait = true
        }
      }
    } else if (i.destinationBedId && i.destinationBedId !== t.toBedId) {
      const dst = await siteNameOf(c.tx, t.destinationSiteId)
      return fail.conflict(`Only the Accommodation Admin of ${dst} chooses the bed there`, `Accommodation Admin of ${dst}`, 'Approve without choosing a bed; the destination site’s admin picks one when they approve', { reason: 'bed_chosen_by_destination' })
    }

    // P-10: the destination key is held back while the bed waits for an exception; the source key (if this actor holds it) is still given.
    const giveDestinationKey = giveDestination && !exceptionWait
    if (exceptionWait && !giveSource) {
      await c.tx.update(transferRequest).set({ toBedId }).where(eq(transferRequest.id, t.id))
      await announceException(c, t, toBedId!, i.note)
      const waiting = await waitingForApproval(c.tx, t)
      return ok({ id: t.id, status: (t.status === 'failed' ? 'failed' : 'requested') as 'failed' | 'requested', keys: { source: !!t.sourceApprovedAt, destination: false }, waitingFor: 'a Policy Approver exception', waitingForException: true },
        `The bed is recorded, but it fails a rule of ${await siteNameOf(c.tx, t.destinationSiteId)}. It waits for a Policy Approver's exception (proposed, pending client sign-off); your approval is not given yet${waiting ? `, and ${waiting.text} still has to approve` : ''}.`)
    }
    const sourceAt = giveSource ? c.now : t.sourceApprovedAt
    const destinationAt = giveDestinationKey ? c.now : t.destinationApprovedAt
    const complete = !!sourceAt && !!destinationAt
    const keys = { source: !!sourceAt, destination: !!destinationAt }
    await c.tx.update(transferRequest).set({
      toBedId,
      ...(giveSource ? { sourceApprovedBy: c.user.id, sourceApprovedAt: c.now } : {}),
      ...(giveDestinationKey ? { destinationApprovedBy: c.user.id, destinationApprovedAt: c.now } : {}),
      ...(complete ? { status: 'approved' as const, decidedBy: c.user.id, decidedAt: c.now, decisionReason: i.note } : {}),
    }).where(eq(transferRequest.id, t.id))

    if (exceptionWait) await announceException(c, t, toBedId!, i.note)

    const round = t.failureCount
    const [srcName, dstName] = crossSite ? [await siteNameOf(c.tx, t.siteId), await siteNameOf(c.tx, t.destinationSiteId)] : ['', '']
    if (crossSite) {
      // One audit row per key, at the site that gave it, so each site's audit log shows its own decision.
      for (const [given, side, siteId] of [[giveSource, 'source', t.siteId], [giveDestinationKey, 'destination', t.destinationSiteId]] as const) {
        if (!given) continue
        await audit(c, {
          action: `stays.${t.kind}.approved_${side}`, entityType: 'transfer_request', entityId: t.id, siteId, reason: i.note ?? undefined,
          before: { status: t.status, keys: { source: !!t.sourceApprovedAt, destination: !!t.destinationApprovedAt } },
          after: { side, keys, toBedId, fromSiteId: t.siteId, toSiteId: t.destinationSiteId },
        })
      }
    }
    if (complete) {
      await audit(c, {
        action: `stays.${t.kind}.approved`, entityType: 'transfer_request', entityId: t.id, siteId: t.siteId, reason: i.note ?? undefined,
        before: { status: t.status, toBedId: t.toBedId }, after: { status: 'approved', toBedId, ...(crossSite ? { fromSiteId: t.siteId, toSiteId: t.destinationSiteId, keys } : {}) },
      })
      const names = await involvedNames(c.tx, t)
      const sentence = `${t.kind === 'swap' ? 'Bed swap' : 'Transfer'} approved for ${names}${crossSite ? ` (${srcName} to ${dstName}, approved by both sites)` : ''}. Please carry it out when the resident is ready.`
      await notify(c.tx, { dedupeKey: `transfer:${t.id}:approved:${round}`, kind: `${t.kind}.approved`, to: { role: 'Rec', siteId: t.siteId }, ref: { type: 'transfer_request', id: t.id }, text: sentence, critical: false })
      if (crossSite) {
        await notify(c.tx, { dedupeKey: `transfer:${t.id}:approved:${round}:destination`, kind: `${t.kind}.approved`, to: { role: 'Rec', siteId: t.destinationSiteId }, ref: { type: 'transfer_request', id: t.id }, text: sentence, critical: false })
      }
      for (const staffId of [t.staffId, t.otherStaffId]) {
        if (staffId) await notify(c.tx, { dedupeKey: `transfer:${t.id}:approved:${round}:${staffId}`, kind: `${t.kind}.approved`, to: { staffId }, ref: { type: 'transfer_request', id: t.id }, text: `Your bed ${t.kind === 'swap' ? 'swap' : 'transfer'} was approved. Reception will arrange the move.` })
      }
      return ok({ id: t.id, status: 'approved' as const, keys, waitingFor: null }, `${t.kind === 'swap' ? 'Swap' : 'Transfer'} approved${crossSite ? ' by both sites' : ''}. Reception can now carry it out.`)
    }

    // One key given, the other site still has to decide: say who, to them and to the people involved.
    const waiting = (await waitingForApproval(c.tx, { ...t, sourceApprovedAt: sourceAt, destinationApprovedAt: destinationAt }))!
    const otherSiteId = keys.source && !keys.destination ? t.destinationSiteId : t.siteId
    const gave = giveSource ? srcName : dstName
    const keyTag = giveSource ? 'source' : 'destination'
    await notify(c.tx, {
      dedupeKey: `transfer:${t.id}:key:${keyTag}:${round}`, kind: `${t.kind}.half_approved`, to: { role: 'AA', siteId: otherSiteId }, ref: { type: 'transfer_request', id: t.id },
      text: `The Accommodation Admin of ${gave} approved the ${t.kind} of ${await involvedNames(c.tx, t)}. It now needs your approval${t.kind === 'transfer' && !keys.destination ? ', and you choose the bed' : ''}.`,
    })
    for (const staffId of [t.staffId, t.otherStaffId]) {
      if (staffId) await notify(c.tx, { dedupeKey: `transfer:${t.id}:key:${keyTag}:${round}:${staffId}`, kind: `${t.kind}.half_approved`, to: { staffId }, ref: { type: 'transfer_request', id: t.id }, text: `${gave} has approved your bed ${t.kind}. It still needs ${waiting.text}. Nothing changes for you until both have approved.` })
    }
    return ok({ id: t.id, status: (t.status === 'failed' ? 'failed' : 'requested') as 'failed' | 'requested', keys, waitingFor: waiting.text },
      `Your approval is recorded. This ${t.kind} still needs ${waiting.text}; nobody moves until both sites have approved.`)
  })
}

/**
 * P-10 (proposed, pending client sign-off): the bed chosen for the move fails a rule of the destination site and waits for a Policy
 * Approver. The approval source puts it in their inbox; this audits that it was recorded and tells the Policy Approvers of that site once.
 */
async function announceException(c: CommandContext, t: TransferRow, bedId: string, note: string | null) {
  const bed = await bedLabel(c.tx, bedId)
  await audit(c, {
    action: 'stays.transfer.exception_needed', entityType: 'transfer_request', entityId: t.id, siteId: t.destinationSiteId, reason: note ?? undefined,
    before: { toBedId: t.toBedId }, after: { toBedId: bedId, bed, waitingForException: true, proposal: 'P-10, pending client sign-off' },
  })
  await notify(c.tx, {
    dedupeKey: `transfer:${t.id}:exception-needed:${bedId}`, kind: 'transfer.exception_needed', to: { role: 'PolicyApprover', siteId: t.destinationSiteId }, ref: { type: 'transfer_request', id: t.id },
    text: `${await staffName(c.tx, t.staffId)} would move into ${bed}, which fails a rule of ${await siteNameOf(c.tx, t.destinationSiteId)} (gender or grade). It waits for your exception decision. Proposed policy, pending client sign-off.`,
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
    let rejectingSite = t.siteId
    if (!occupantDeclines) {
      // Either site's Accommodation Admin can refuse the move (it needs both keys, so one "no" ends it).
      const sides = await sideAuthority(c, t)
      if (isFailure(sides)) return sides
      if (!sides.source && sides.destination) rejectingSite = t.destinationSiteId
      const self = notInvolved(c, [t.staffId, t.otherStaffId, t.requestedByStaffId], `reject this ${t.kind}`)
      if (self) return self
      if (t.requestedBy && t.requestedBy === c.user.id) return fail.sod(`You cannot reject this ${t.kind}: you raised it`, 'An independent approver must do this (D-26, D-109). To take it back, withdraw it')
    }
    if (!['requested', 'approved', 'failed'].includes(t.status)) return fail.conflict(`This ${t.kind} is already ${t.status}`, 'Accommodation Admin', 'Nothing more to do')
    if (occupantDeclines && t.status !== 'requested') return fail.conflict('The swap is already approved', 'Accommodation Admin', 'Ask the Accommodation Admin to cancel it')

    await c.tx.update(transferRequest).set({ status: 'rejected', decidedBy: c.user.id, decidedAt: c.now, decisionReason: i.reason }).where(eq(transferRequest.id, t.id))
    await audit(c, {
      action: `stays.${t.kind}.rejected`, entityType: 'transfer_request', entityId: t.id, siteId: rejectingSite, reason: i.reason, before: { status: t.status },
      after: { status: 'rejected', byOccupant: occupantDeclines, ...(isCrossSite(t) ? { fromSiteId: t.siteId, toSiteId: t.destinationSiteId, rejectedAt: rejectingSite === t.siteId ? 'source' : 'destination' } : {}) },
    })
    for (const staffId of [t.staffId, t.otherStaffId, t.requestedByStaffId]) {
      if (staffId) await notify(c.tx, { dedupeKey: `transfer:${t.id}:rejected:${staffId}`, kind: `${t.kind}.rejected`, to: { staffId }, ref: { type: 'transfer_request', id: t.id }, text: `The bed ${t.kind} was not approved: ${i.reason}` })
    }
    return ok({ id: t.id, status: 'rejected' as const }, `${t.kind === 'swap' ? 'Swap' : 'Transfer'} rejected. Nobody was moved.`)
  })
}
