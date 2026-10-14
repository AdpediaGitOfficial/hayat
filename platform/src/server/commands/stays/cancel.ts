import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { checkoutRequest, extensionRequest, transferRequest } from '@/server/db/schema.stays'
import { audit } from '@/server/audit'
import { runCommand } from '@/server/command/run'
import type { RequestContext } from '@/server/command/context'
import { fail, ok, type Result } from '@/server/command/result'
import { decide } from '@/server/policy'
import { notify } from '@/server/notify'
import type { Tx } from '@/server/command/context'
import { idSchema, noteSchema } from './shared'

export const input = z.object({ kind: z.enum(['transfer', 'extension', 'checkout']), id: idSchema, note: noteSchema })
export type CancelRequestInput = z.infer<typeof input>

/**
 * Withdraws a request that has not been carried out: the person it is about, whoever raised it, or an Accommodation Admin
 * of the site. Cancelling changes nothing about the stay.
 */
export function cancelRequest(rc: RequestContext, i: CancelRequestInput): Promise<Result<{ id: string; status: 'cancelled' }>> {
  return runCommand(rc, async c => {
    const r = await loadRequest(c.tx, i.kind, i.id)
    if (!r) return fail.notFound()
    const mine = c.actor.staffId !== undefined && (c.actor.staffId === r.staffId || c.actor.staffId === r.otherStaffId)
    const raisedByMe = r.requestedBy === c.user.id
    // A cross-site move (D-104) belongs to both sites: an Accommodation Admin of either may withdraw it.
    const sites = [r.siteId, ...(r.destinationSiteId && r.destinationSiteId !== r.siteId ? [r.destinationSiteId] : [])]
    const asAdmin = sites.some(siteId => decide(c.actor, 'transfers_swaps.approve', { siteId }).allowed) || (i.kind === 'checkout' && decide(c.actor, 'checkin_checkout.execute', { siteId: r.siteId }).allowed)
    const ownScope = mine || sites.some(siteId => decide(c.actor, 'reservations_stays.view', { siteId, ownerStaffId: r.staffId }).allowed)
    if (!ownScope) return fail.notFound()
    if (!(mine || raisedByMe || asAdmin)) return fail.forbidden('cancel this request', 'The person it is about, or an Accommodation Admin')
    const open = i.kind === 'transfer' ? ['requested', 'approved', 'failed'] : i.kind === 'extension' ? ['requested'] : ['requested', 'acknowledged']
    if (!open.includes(r.status)) return fail.conflict(`This request is already ${r.status}`, 'Accommodation Admin', 'Nothing to cancel')

    if (i.kind === 'transfer') await c.tx.update(transferRequest).set({ status: 'cancelled', decidedBy: c.user.id, decidedAt: c.now, decisionReason: i.note }).where(eq(transferRequest.id, r.id))
    else if (i.kind === 'extension') await c.tx.update(extensionRequest).set({ status: 'cancelled', decidedBy: c.user.id, decidedAt: c.now, decisionReason: i.note }).where(eq(extensionRequest.id, r.id))
    else await c.tx.update(checkoutRequest).set({ status: 'cancelled', cancelledAt: c.now }).where(eq(checkoutRequest.id, r.id))

    await audit(c, { action: `stays.${i.kind}.cancelled`, entityType: i.kind === 'transfer' ? 'transfer_request' : i.kind === 'extension' ? 'extension_request' : 'checkout_request', entityId: r.id, siteId: r.siteId, reason: i.note ?? undefined, before: { status: r.status }, after: { status: 'cancelled' } })
    if (c.actor.staffId !== r.staffId) {
      await notify(c.tx, { dedupeKey: `${i.kind}:${r.id}:cancelled`, kind: `${i.kind}.cancelled`, to: { staffId: r.staffId }, ref: { type: `${i.kind}_request`, id: r.id }, text: `The ${i.kind} request for your stay was cancelled.` })
    }
    return ok({ id: r.id, status: 'cancelled' as const }, 'Request cancelled. Nothing about the stay changed.')
  })
}

interface Row { id: string; siteId: string; destinationSiteId: string | null; staffId: string; status: string; requestedBy: string | null; otherStaffId: string | null }
async function loadRequest(tx: Tx, kind: CancelRequestInput['kind'], id: string): Promise<Row | undefined> {
  if (kind === 'transfer') return (await tx.select({ id: transferRequest.id, siteId: transferRequest.siteId, destinationSiteId: transferRequest.destinationSiteId, staffId: transferRequest.staffId, status: transferRequest.status, requestedBy: transferRequest.requestedBy, otherStaffId: transferRequest.otherStaffId }).from(transferRequest).where(eq(transferRequest.id, id)).limit(1).for('update'))[0]
  if (kind === 'extension') return (await tx.select({ id: extensionRequest.id, siteId: extensionRequest.siteId, staffId: extensionRequest.staffId, status: extensionRequest.status, requestedBy: extensionRequest.requestedBy }).from(extensionRequest).where(eq(extensionRequest.id, id)).limit(1).for('update')).map(r => ({ ...r, destinationSiteId: null, otherStaffId: null }))[0]
  return (await tx.select({ id: checkoutRequest.id, siteId: checkoutRequest.siteId, staffId: checkoutRequest.staffId, status: checkoutRequest.status, requestedBy: checkoutRequest.requestedBy }).from(checkoutRequest).where(eq(checkoutRequest.id, id)).limit(1).for('update')).map(r => ({ ...r, destinationSiteId: null, otherStaffId: null }))[0]
}
