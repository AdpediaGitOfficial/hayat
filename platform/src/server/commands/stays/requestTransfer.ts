import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { extensionRequest, transferRequest } from '@/server/db/schema.stays'
import { audit } from '@/server/audit'
import { runCommand } from '@/server/command/run'
import type { RequestContext } from '@/server/command/context'
import { fail, ok, type Result } from '@/server/command/result'
import { notify } from '@/server/notify'
import { guardUnique } from '@/server/commands/property/shared'
import { bed } from '@/server/db/schema'
import { noGrantFor } from '@/server/approvals/escalation'
import { authorizeAny, dateSchema, idSchema, loadStayLocked, loadStaysLocked, reasonSchema, staffName } from './shared'
import { checkDestination, checkDestinationSite, checkEligibleAt, consentInput, openTransfersFor, siteNameOf } from './transferShared'

const optionalId = idSchema.nullish().transform(v => v ?? null)
const optionalDate = dateSchema.nullish().transform(v => v ?? null)

/* ---------------- transfer (D-61) ---------------- */

export const input = z.object({
  stayId: idSchema,
  /**
   * The site to move INTO (D-104: transfers may cross sites). Left out = the bed's site, or the stay's own site when no bed is chosen.
   * Any live site may be named: the Accommodation Admin of the destination site decides, so the requester needs no scope there.
   */
  destinationSiteId: idSchema.nullish(),
  /** Null = "any suitable bed": the Accommodation Admin of the destination site picks one when approving. */
  destinationBedId: optionalId,
  reason: reasonSchema,
  neededBy: optionalDate,
  /** An extension that could not be approved on the current bed because of the next booking (D-57). */
  linkedExtensionId: optionalId,
})
export type RequestTransferInput = z.infer<typeof input>
export interface RequestTransferOut { id: string; status: 'requested'; crossSite: boolean }

/** Who may raise a transfer or swap for a stay: the resident for their own stay, or an Accommodation Admin for anyone in their sites. */
const REQUESTERS = ['transfers_swaps.request', 'transfers_swaps.approve'] as const

export function requestTransfer(rc: RequestContext, i: RequestTransferInput): Promise<Result<RequestTransferOut>> {
  return runCommand<RequestTransferOut>(rc, async c => {
    // Someone who may never request or approve a transfer learns nothing about the stay (a real one and a missing one answer alike).
    const none = noGrantFor(c.actor, REQUESTERS, ['reservations_stays.view'])
    if (none) return none
    const s = await loadStayLocked(c.tx, i.stayId)
    if (!s) return fail.notFound()
    const denied = authorizeAny(c, REQUESTERS, { siteId: s.siteId, ownerStaffId: s.staffId })
    if (denied) return denied
    if (s.status !== 'active') return fail.conflict(`The stay is ${s.status.replace('_', ' ')}, so it cannot be moved`, 'Accommodation Admin', 'Only an active stay can be transferred')

    const open = await openTransfersFor(c.tx, [s.id])
    if (open.length) return fail.conflict('There is already an open transfer or swap for this stay', 'Accommodation Admin', 'Finish or cancel it first', { reason: 'open_transfer', transferId: open[0].id })

    // Where to? The chosen bed decides its own site; with no bed the named site; with neither, the stay's own site (as before D-104).
    let destinationSiteId = i.destinationSiteId ?? s.siteId
    if (i.destinationBedId) {
      const [b] = await c.tx.select({ siteId: bed.siteId }).from(bed).where(eq(bed.id, i.destinationBedId)).limit(1)
      if (!b) return fail.invalid('That bed does not exist', { destinationBedId: 'Choose a bed from the list' })
      if (i.destinationSiteId && i.destinationSiteId !== b.siteId) return fail.invalid('That bed is not in the site you chose', { destinationBedId: 'Choose a bed of the destination site' })
      destinationSiteId = b.siteId
    }
    const crossSite = destinationSiteId !== s.siteId
    if (crossSite) {
      const badSite = await checkDestinationSite(c.tx, destinationSiteId)
      if (badSite) return badSite
    }
    if (i.destinationBedId) {
      const bad = await checkDestination(c.tx, { siteId: destinationSiteId, currentBedId: s.bedId }, i.destinationBedId)
      if (bad) return bad
      // Another site has its own gender and grade rules: say so now, not after two Accommodation Admins have looked at it.
      if (crossSite) {
        const ineligible = await checkEligibleAt(c, s.staffId, i.destinationBedId)
        if (ineligible) return ineligible
      }
    }
    if (i.linkedExtensionId) {
      const [ext] = await c.tx.select().from(extensionRequest).where(and(eq(extensionRequest.id, i.linkedExtensionId), eq(extensionRequest.stayId, s.id))).limit(1)
      if (!ext) return fail.invalid('That extension request does not belong to this stay', { linkedExtensionId: 'Not found for this stay' })
    }

    const created = await guardUnique(c.tx, q => q.insert(transferRequest).values({
      kind: 'transfer', siteId: s.siteId, destinationSiteId, stayId: s.id, staffId: s.staffId, fromBedId: s.bedId, toBedId: i.destinationBedId,
      reason: i.reason, neededBy: i.neededBy, linkedExtensionId: i.linkedExtensionId, status: 'requested',
      requestedBy: c.user.id, requestedByStaffId: c.actor.staffId ?? null, createdAt: c.now,
    }).returning({ id: transferRequest.id }))
    if (!created) return fail.conflict('There is already an open transfer or swap for this stay', 'Accommodation Admin', 'Finish or cancel it first', { reason: 'open_transfer' })
    const id = created[0].id

    const who = await staffName(c.tx, s.staffId)
    await audit(c, {
      action: 'stays.transfer.requested', entityType: 'transfer_request', entityId: id, siteId: s.siteId, reason: i.reason,
      after: { kind: 'transfer', stayId: s.id, staffId: s.staffId, fromBedId: s.bedId, toBedId: i.destinationBedId, anySuitable: !i.destinationBedId, linkedExtensionId: i.linkedExtensionId, fromSiteId: s.siteId, toSiteId: destinationSiteId, crossSite },
    })
    if (!crossSite) {
      await notify(c.tx, { dedupeKey: `transfer:${id}:requested`, kind: 'transfer.requested', to: { role: 'AA', siteId: s.siteId }, ref: { type: 'transfer_request', id }, text: `Transfer requested for ${who}: ${i.reason}` })
      if (c.actor.staffId !== s.staffId) {
        await notify(c.tx, { dedupeKey: `transfer:${id}:requested:resident`, kind: 'transfer.requested', to: { staffId: s.staffId }, ref: { type: 'transfer_request', id }, text: 'A bed transfer has been requested for you. An Accommodation Admin will decide it.' })
      }
      return ok({ id, status: 'requested' as const, crossSite: false }, 'Transfer requested. An Accommodation Admin decides it; Reception then moves the resident.')
    }

    // Two keys (D-104): the Accommodation Admin of each site is told, and each is told what the other has to do.
    const [fromName, toName] = [await siteNameOf(c.tx, s.siteId), await siteNameOf(c.tx, destinationSiteId)]
    await audit(c, {
      action: 'stays.transfer.requested_cross_site', entityType: 'transfer_request', entityId: id, siteId: destinationSiteId, reason: i.reason,
      after: { stayId: s.id, fromSiteId: s.siteId, toSiteId: destinationSiteId, toBedId: i.destinationBedId, anySuitable: !i.destinationBedId },
    })
    await notify(c.tx, { dedupeKey: `transfer:${id}:requested`, kind: 'transfer.requested', to: { role: 'AA', siteId: s.siteId }, ref: { type: 'transfer_request', id }, text: `Transfer to ${toName} requested for ${who}: ${i.reason}. You approve the move out of ${fromName}; the Accommodation Admin of ${toName} approves the move in.` })
    await notify(c.tx, { dedupeKey: `transfer:${id}:requested:destination`, kind: 'transfer.requested', to: { role: 'AA', siteId: destinationSiteId }, ref: { type: 'transfer_request', id }, text: `${who} has asked to move from ${fromName} into ${toName}: ${i.reason}. ${i.destinationBedId ? 'A bed was suggested.' : 'You choose the bed when you approve.'} The Accommodation Admin of ${fromName} approves the move out.` })
    if (c.actor.staffId !== s.staffId) {
      await notify(c.tx, { dedupeKey: `transfer:${id}:requested:resident`, kind: 'transfer.requested', to: { staffId: s.staffId }, ref: { type: 'transfer_request', id }, text: `A move to ${toName} has been requested for you. The Accommodation Admins of ${fromName} and ${toName} both decide it.` })
    }
    return ok({ id, status: 'requested' as const, crossSite: true }, `Move to ${toName} requested. The Accommodation Admin of ${fromName} and the Accommodation Admin of ${toName} both have to approve; Reception then moves the resident.`)
  })
}

/* ---------------- swap (D-62) ---------------- */

export const swapInput = z.object({
  stayId: idSchema,
  otherStayId: idSchema,
  reason: reasonSchema,
  neededBy: optionalDate,
  /** How each occupant consented, when the Accommodation Admin has already asked them. Left out = the occupant confirms in the app (recordSwapConsent). */
  consentFirst: consentInput.nullish().transform(v => v ?? null),
  consentSecond: consentInput.nullish().transform(v => v ?? null),
})
export type RequestSwapInput = z.infer<typeof swapInput>

export function requestSwap(rc: RequestContext, i: RequestSwapInput): Promise<Result<RequestTransferOut>> {
  return runCommand<RequestTransferOut>(rc, async c => {
    if (i.stayId === i.otherStayId) return fail.invalid('A swap needs two different stays', { otherStayId: 'Choose the other resident’s stay' })
    const stays = await loadStaysLocked(c.tx, [i.stayId, i.otherStayId])
    const a = stays.find(x => x.id === i.stayId)
    const b = stays.find(x => x.id === i.otherStayId)
    if (!a || !b) return fail.notFound()
    // Swaps are arranged at the desk: an Accommodation Admin raises them and records how each occupant consented. Across sites (D-104) the
    // raiser needs scope on ONE of the two sites; the Accommodation Admin of the other site approves it, so no scope is widened.
    const denied = authorizeAny(c, ['transfers_swaps.approve'], { siteId: a.siteId })
    if (denied && (a.siteId === b.siteId || authorizeAny(c, ['transfers_swaps.approve'], { siteId: b.siteId }))) return denied
    const crossSite = a.siteId !== b.siteId
    if (a.staffId === b.staffId) return fail.invalid('Both stays belong to the same person', { otherStayId: 'Choose another resident’s stay' })
    for (const s of [a, b]) {
      if (s.status !== 'active') return fail.conflict(`A stay in this swap is ${s.status.replace('_', ' ')}`, 'Accommodation Admin', 'Only active stays can swap beds')
    }
    const open = await openTransfersFor(c.tx, [a.id, b.id])
    if (open.length) return fail.conflict('One of these stays is already in an open transfer or swap', 'Accommodation Admin', 'Finish or cancel that one first', { reason: 'open_transfer', transferId: open[0].id })

    if (crossSite) {
      // Each person is judged against the rules of the site they would move INTO.
      for (const [who, bedId] of [[a, b.bedId], [b, a.bedId]] as const) {
        const bad = await checkEligibleAt(c, who.staffId, bedId)
        if (bad) return { ...bad, reason: `${await staffName(c.tx, who.staffId)}: ${bad.reason}` }
      }
    }

    const now = c.now
    const first = i.consentFirst ? { at: now, by: c.user.id, via: i.consentFirst.via, note: i.consentFirst.note } : null
    const second = i.consentSecond ? { at: now, by: c.user.id, via: i.consentSecond.via, note: i.consentSecond.note } : null

    const created = await guardUnique(c.tx, q => q.insert(transferRequest).values({
      kind: 'swap', siteId: a.siteId, destinationSiteId: b.siteId, stayId: a.id, staffId: a.staffId, fromBedId: a.bedId, toBedId: b.bedId,
      otherStayId: b.id, otherStaffId: b.staffId, reason: i.reason, neededBy: i.neededBy, status: 'requested',
      requestedBy: c.user.id, requestedByStaffId: c.actor.staffId ?? null, createdAt: c.now,
      consentAAt: first?.at ?? null, consentABy: first?.by ?? null, consentAVia: first?.via ?? null, consentANote: first?.note ?? null,
      consentBAt: second?.at ?? null, consentBBy: second?.by ?? null, consentBVia: second?.via ?? null, consentBNote: second?.note ?? null,
    }).returning({ id: transferRequest.id }))
    if (!created) return fail.conflict('One of these stays is already in an open transfer or swap', 'Accommodation Admin', 'Finish or cancel that one first', { reason: 'open_transfer' })
    const id = created[0].id

    const [na, nb] = [await staffName(c.tx, a.staffId), await staffName(c.tx, b.staffId)]
    await audit(c, {
      action: 'stays.swap.requested', entityType: 'transfer_request', entityId: id, siteId: a.siteId, reason: i.reason,
      after: { kind: 'swap', stayId: a.id, otherStayId: b.id, bedA: a.bedId, bedB: b.bedId, consentA: first?.via ?? null, consentB: second?.via ?? null, fromSiteId: a.siteId, toSiteId: b.siteId, crossSite },
    })
    await notify(c.tx, { dedupeKey: `transfer:${id}:requested`, kind: 'swap.requested', to: { role: 'AA', siteId: a.siteId }, ref: { type: 'transfer_request', id }, text: `Bed swap requested between ${na} and ${nb}: ${i.reason}` })
    if (crossSite) {
      const [sa, sb] = [await siteNameOf(c.tx, a.siteId), await siteNameOf(c.tx, b.siteId)]
      await audit(c, {
        action: 'stays.swap.requested_cross_site', entityType: 'transfer_request', entityId: id, siteId: b.siteId, reason: i.reason,
        after: { stayId: a.id, otherStayId: b.id, fromSiteId: a.siteId, toSiteId: b.siteId },
      })
      await notify(c.tx, { dedupeKey: `transfer:${id}:requested:destination`, kind: 'swap.requested', to: { role: 'AA', siteId: b.siteId }, ref: { type: 'transfer_request', id }, text: `Bed swap between ${na} (${sa}) and ${nb} (${sb}) requested: ${i.reason}. The Accommodation Admins of both sites have to approve it.` })
    }
    const pending = [first ? null : { staffId: a.staffId, key: 'a', partner: nb }, second ? null : { staffId: b.staffId, key: 'b', partner: na }]
    for (const p of pending) {
      if (!p) continue
      await notify(c.tx, { dedupeKey: `transfer:${id}:consent_needed:${p.key}`, kind: 'swap.consent_needed', to: { staffId: p.staffId }, ref: { type: 'transfer_request', id }, text: `A bed swap with ${p.partner} has been proposed. Please confirm if you agree, or tell Reception if you do not.` })
    }
    return ok({ id, status: 'requested' as const, crossSite }, crossSite
      ? 'Swap requested. It needs both residents’ consent and the approval of the Accommodation Admin of each site.'
      : 'Swap requested. It needs both residents’ consent and an Accommodation Admin’s approval.')
  })
}
