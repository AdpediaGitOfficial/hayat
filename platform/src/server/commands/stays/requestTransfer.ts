import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { extensionRequest, transferRequest } from '@/server/db/schema.stays'
import { audit } from '@/server/audit'
import { runCommand } from '@/server/command/run'
import type { RequestContext } from '@/server/command/context'
import { fail, ok, type Result } from '@/server/command/result'
import { notify } from '@/server/notify'
import { guardUnique } from '@/server/commands/property/shared'
import { authorizeAny, dateSchema, idSchema, loadStayLocked, loadStaysLocked, reasonSchema, staffName } from './shared'
import { checkDestination, consentInput, openTransfersFor } from './transferShared'

const optionalId = idSchema.nullish().transform(v => v ?? null)
const optionalDate = dateSchema.nullish().transform(v => v ?? null)

/* ---------------- transfer (D-61) ---------------- */

export const input = z.object({
  stayId: idSchema,
  /** Null = "any suitable bed": the Accommodation Admin picks one when approving. */
  destinationBedId: optionalId,
  reason: reasonSchema,
  neededBy: optionalDate,
  /** An extension that could not be approved on the current bed because of the next booking (D-57). */
  linkedExtensionId: optionalId,
})
export type RequestTransferInput = z.infer<typeof input>
export interface RequestTransferOut { id: string; status: 'requested' }

/** Who may raise a transfer or swap for a stay: the resident for their own stay, or an Accommodation Admin for anyone in their sites. */
const REQUESTERS = ['transfers_swaps.request', 'transfers_swaps.approve'] as const

export function requestTransfer(rc: RequestContext, i: RequestTransferInput): Promise<Result<RequestTransferOut>> {
  return runCommand(rc, async c => {
    const s = await loadStayLocked(c.tx, i.stayId)
    if (!s) return fail.notFound()
    const denied = authorizeAny(c, REQUESTERS, { siteId: s.siteId, ownerStaffId: s.staffId })
    if (denied) return denied
    if (s.status !== 'active') return fail.conflict(`The stay is ${s.status.replace('_', ' ')}, so it cannot be moved`, 'Accommodation Admin', 'Only an active stay can be transferred')

    const open = await openTransfersFor(c.tx, [s.id])
    if (open.length) return fail.conflict('There is already an open transfer or swap for this stay', 'Accommodation Admin', 'Finish or cancel it first', { reason: 'open_transfer', transferId: open[0].id })

    if (i.destinationBedId) {
      const bad = await checkDestination(c.tx, { siteId: s.siteId, currentBedId: s.bedId }, i.destinationBedId)
      if (bad) return bad
    }
    if (i.linkedExtensionId) {
      const [ext] = await c.tx.select().from(extensionRequest).where(and(eq(extensionRequest.id, i.linkedExtensionId), eq(extensionRequest.stayId, s.id))).limit(1)
      if (!ext) return fail.invalid('That extension request does not belong to this stay', { linkedExtensionId: 'Not found for this stay' })
    }

    const created = await guardUnique(c.tx, q => q.insert(transferRequest).values({
      kind: 'transfer', siteId: s.siteId, stayId: s.id, staffId: s.staffId, fromBedId: s.bedId, toBedId: i.destinationBedId,
      reason: i.reason, neededBy: i.neededBy, linkedExtensionId: i.linkedExtensionId, status: 'requested',
      requestedBy: c.user.id, requestedByStaffId: c.actor.staffId ?? null, createdAt: c.now,
    }).returning({ id: transferRequest.id }))
    if (!created) return fail.conflict('There is already an open transfer or swap for this stay', 'Accommodation Admin', 'Finish or cancel it first', { reason: 'open_transfer' })
    const id = created[0].id

    const who = await staffName(c.tx, s.staffId)
    await audit(c, {
      action: 'stays.transfer.requested', entityType: 'transfer_request', entityId: id, siteId: s.siteId, reason: i.reason,
      after: { kind: 'transfer', stayId: s.id, staffId: s.staffId, fromBedId: s.bedId, toBedId: i.destinationBedId, anySuitable: !i.destinationBedId, linkedExtensionId: i.linkedExtensionId },
    })
    await notify(c.tx, { dedupeKey: `transfer:${id}:requested`, kind: 'transfer.requested', to: { role: 'AA', siteId: s.siteId }, ref: { type: 'transfer_request', id }, text: `Transfer requested for ${who}: ${i.reason}` })
    if (c.actor.staffId !== s.staffId) {
      await notify(c.tx, { dedupeKey: `transfer:${id}:requested:resident`, kind: 'transfer.requested', to: { staffId: s.staffId }, ref: { type: 'transfer_request', id }, text: 'A bed transfer has been requested for you. An Accommodation Admin will decide it.' })
    }
    return ok({ id, status: 'requested' as const }, 'Transfer requested. An Accommodation Admin decides it; Reception then moves the resident.')
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
  return runCommand(rc, async c => {
    if (i.stayId === i.otherStayId) return fail.invalid('A swap needs two different stays', { otherStayId: 'Choose the other resident’s stay' })
    const stays = await loadStaysLocked(c.tx, [i.stayId, i.otherStayId])
    const a = stays.find(x => x.id === i.stayId)
    const b = stays.find(x => x.id === i.otherStayId)
    if (!a || !b) return fail.notFound()
    // Swaps are arranged at the desk: an Accommodation Admin of the site raises them and records how each occupant consented.
    const denied = authorizeAny(c, ['transfers_swaps.approve'], { siteId: a.siteId }) ?? authorizeAny(c, ['transfers_swaps.approve'], { siteId: b.siteId })
    if (denied) return denied
    if (a.siteId !== b.siteId) return fail.conflict('A swap is between two beds of the same site', 'Accommodation Admin', 'Use two transfers through the waitlist, or move one resident with a new request', { reason: 'cross_site' })
    if (a.staffId === b.staffId) return fail.invalid('Both stays belong to the same person', { otherStayId: 'Choose another resident’s stay' })
    for (const s of [a, b]) {
      if (s.status !== 'active') return fail.conflict(`A stay in this swap is ${s.status.replace('_', ' ')}`, 'Accommodation Admin', 'Only active stays can swap beds')
    }
    const open = await openTransfersFor(c.tx, [a.id, b.id])
    if (open.length) return fail.conflict('One of these stays is already in an open transfer or swap', 'Accommodation Admin', 'Finish or cancel that one first', { reason: 'open_transfer', transferId: open[0].id })

    const now = c.now
    const first = i.consentFirst ? { at: now, by: c.user.id, via: i.consentFirst.via, note: i.consentFirst.note } : null
    const second = i.consentSecond ? { at: now, by: c.user.id, via: i.consentSecond.via, note: i.consentSecond.note } : null

    const created = await guardUnique(c.tx, q => q.insert(transferRequest).values({
      kind: 'swap', siteId: a.siteId, stayId: a.id, staffId: a.staffId, fromBedId: a.bedId, toBedId: b.bedId,
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
      after: { kind: 'swap', stayId: a.id, otherStayId: b.id, bedA: a.bedId, bedB: b.bedId, consentA: first?.via ?? null, consentB: second?.via ?? null },
    })
    await notify(c.tx, { dedupeKey: `transfer:${id}:requested`, kind: 'swap.requested', to: { role: 'AA', siteId: a.siteId }, ref: { type: 'transfer_request', id }, text: `Bed swap requested between ${na} and ${nb}: ${i.reason}` })
    const pending = [first ? null : { staffId: a.staffId, key: 'a', partner: nb }, second ? null : { staffId: b.staffId, key: 'b', partner: na }]
    for (const p of pending) {
      if (!p) continue
      await notify(c.tx, { dedupeKey: `transfer:${id}:consent_needed:${p.key}`, kind: 'swap.consent_needed', to: { staffId: p.staffId }, ref: { type: 'transfer_request', id }, text: `A bed swap with ${p.partner} has been proposed. Please confirm if you agree, or tell Reception if you do not.` })
    }
    return ok({ id, status: 'requested' as const }, 'Swap requested. It needs both residents’ consent and an Accommodation Admin’s approval.')
  })
}
