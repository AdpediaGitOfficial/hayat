import { and, desc, eq, inArray, or, sql } from 'drizzle-orm'
import { stay } from '@/server/db/schema'
import { checkoutRequest, extensionRequest, transferRequest } from '@/server/db/schema.stays'
import { getDb } from '@/server/db/client'
import { can, scopeFilter, type Actor } from '@/server/policy'
import { getClock } from '@/server/runtime'
import { suggestBeds, type BedSuggestion } from '@/server/allocation'
import { scopeSql } from '@/server/queries/scope'
import { bedInfoMap, localDate, personMap, personOf } from './common'

export interface TransferListRow {
  id: string
  kind: 'transfer' | 'swap'
  status: string
  siteId: string
  stayId: string
  otherStayId: string | null
  staffId: string
  otherStaffId: string | null
  name: string
  otherName: string | null
  fromBedLabel: string
  toBedId: string | null
  toBedLabel: string | null
  reason: string
  neededBy: string | null
  createdAt: string
  requestedByStaffId: string | null
  consent: { a: boolean; b: boolean } | null
  failureReason: string | null
  failureNext: string | null
  failedAt: string | null
  executedAt: string | null
  decisionReason: string | null
  /** Beds ready now that could take the move (offered when no destination is chosen, or after a failure). */
  suggestions: BedSuggestion[]
  /** Set when the viewer is one of the two residents in a swap (resident mode): they answer for themselves. */
  viewerParty: 'a' | 'b' | null
  can: { approve: boolean; execute: boolean; consent: boolean; cancel: boolean }
}

export interface TransferFilters { status?: string; siteId?: string; limit?: number }

/** Transfers and swaps the actor may see (`transfers_swaps.view`: their sites, or those they are part of). Open ones first. */
export async function listTransfers(actor: Actor, f: TransferFilters = {}, now: Date = getClock().now()): Promise<TransferListRow[]> {
  const db = getDb()
  const sf = scopeFilter(actor, 'transfers_swaps.view')
  const scope = scopeSql(sf, { site: transferRequest.siteId, owner: transferRequest.staffId })
  const alsoOther = sf.kind === 'restricted' && sf.ownerStaffId ? eq(transferRequest.otherStaffId, sf.ownerStaffId) : undefined
  const raw = await db.select().from(transferRequest)
    .where(and(
      scope && alsoOther ? or(scope, alsoOther) : scope,
      f.status === 'open' ? inArray(transferRequest.status, ['requested', 'approved', 'failed']) : f.status ? eq(transferRequest.status, f.status as 'requested') : undefined,
      f.siteId ? eq(transferRequest.siteId, f.siteId) : undefined,
    ))
    .orderBy(sql`(${transferRequest.status} in ('requested','approved','failed')) desc`, desc(transferRequest.createdAt)).limit(f.limit ?? 100)
  if (raw.length === 0) return []

  const beds = await bedInfoMap(raw.flatMap(t => [t.fromBedId, t.toBedId].filter((x): x is string => !!x)))
  const people = await personMap(actor, raw.flatMap(t => [{ staffId: t.staffId, siteId: t.siteId }, ...(t.otherStaffId ? [{ staffId: t.otherStaffId, siteId: t.siteId }] : [])]))
  const stays = await db.select({ id: stay.id, claim: sql<string | null>`upper((select period from bed_claim where id = ${stay.claimId}))::text` }).from(stay).where(inArray(stay.id, raw.map(t => t.stayId)))
  const endOf = new Map(stays.map(s => [s.id, s.claim]))

  const out: TransferListRow[] = []
  for (const t of raw) {
    const open = t.status === 'requested' || t.status === 'failed'
    const info = beds.get(t.fromBedId)
    let suggestions: BedSuggestion[] = []
    if (t.kind === 'transfer' && open && info) {
      const today = localDate(now, info.siteTimeZone)
      const to = endOf.get(t.stayId) ?? undefined
      if (!to || to > today) {
        suggestions = (await suggestBeds(db, { staffId: t.staffId, siteId: t.siteId, from: today, to: to ?? undefined, limit: 8, excludeBedIds: [t.fromBedId], now })).filter(b => b.state === 'available').slice(0, 5)
      }
    }
    const res = { siteId: t.siteId, ownerStaffId: t.staffId }
    const myPart = actor.staffId !== undefined && (actor.staffId === t.staffId || actor.staffId === t.otherStaffId)
    out.push({
      id: t.id, kind: t.kind, status: t.status, siteId: t.siteId, stayId: t.stayId, otherStayId: t.otherStayId, staffId: t.staffId, otherStaffId: t.otherStaffId,
      name: personOf(people, t.staffId).name, otherName: t.otherStaffId ? personOf(people, t.otherStaffId).name : null,
      fromBedLabel: info?.label ?? '', toBedId: t.toBedId, toBedLabel: t.toBedId ? beds.get(t.toBedId)?.label ?? null : null,
      reason: t.reason, neededBy: t.neededBy, createdAt: t.createdAt.toISOString(), requestedByStaffId: t.requestedByStaffId,
      consent: t.kind === 'swap' ? { a: !!t.consentAAt, b: !!t.consentBAt } : null,
      failureReason: t.status === 'failed' ? t.failureReason : null,
      failureNext: t.status === 'failed' ? ((t.failureDetail as { next?: string } | null)?.next ?? null) : null,
      failedAt: t.failedAt?.toISOString() ?? null, executedAt: t.executedAt?.toISOString() ?? null, decisionReason: t.decisionReason,
      suggestions,
      viewerParty: t.kind === 'swap' && actor.role === 'Res' && actor.staffId ? (actor.staffId === t.staffId ? 'a' : actor.staffId === t.otherStaffId ? 'b' : null) : null,
      can: {
        approve: open && (can(actor, 'transfers_swaps.approve', res) || can(actor, 'approvals_inbox.decide_escalated', res)) && !(myPart || actor.staffId === t.requestedByStaffId),
        execute: t.status === 'approved' && can(actor, 'transfers_swaps.execute', res) && !myPart,
        consent: t.kind === 'swap' && t.status === 'requested' && (myPart && actor.role === 'Res' || can(actor, 'transfers_swaps.approve', res)),
        cancel: ['requested', 'approved', 'failed'].includes(t.status) && (myPart || can(actor, 'transfers_swaps.approve', res)),
      },
    })
  }
  return out
}

/* ---------------- extension and checkout requests awaiting someone ---------------- */

export interface PendingExtension { id: string; stayId: string; staffId: string; name: string; bedLabel: string; currentEnd: string; newEnd: string; addedDays: number; beyondPolicy: boolean; reason: string | null; createdAt: string; clash: { message?: string; suggestions?: BedSuggestion[] } | null; canDecide: boolean }
export interface PendingCheckout { id: string; stayId: string; staffId: string; name: string; bedLabel: string; departureDate: string; note: string | null; status: string; createdAt: string; canProcess: boolean }

/** Open extension requests (to decide) and checkout requests (to acknowledge and process) in the actor's sites. */
export async function listPendingRequests(actor: Actor): Promise<{ extensions: PendingExtension[]; checkouts: PendingCheckout[] }> {
  const db = getDb()
  const extScope = scopeFilter(actor, 'reservations_stays.view')
  const exts = await db.select().from(extensionRequest).where(and(eq(extensionRequest.status, 'requested'), scopeSql(extScope, { site: extensionRequest.siteId, owner: extensionRequest.staffId }))).orderBy(extensionRequest.createdAt).limit(100)
  const outScope = scopeFilter(actor, 'checkin_checkout.view')
  const outs = await db.select().from(checkoutRequest).where(and(inArray(checkoutRequest.status, ['requested', 'acknowledged']), scopeSql(outScope, { site: checkoutRequest.siteId }))).orderBy(checkoutRequest.createdAt).limit(100)
  if (exts.length + outs.length === 0) return { extensions: [], checkouts: [] }
  const stayRows = await db.select({ id: stay.id, bedId: stay.bedId }).from(stay).where(inArray(stay.id, [...exts.map(e => e.stayId), ...outs.map(o => o.stayId)]))
  const bedOfStay = new Map(stayRows.map(s => [s.id, s.bedId]))
  const beds = await bedInfoMap(stayRows.map(s => s.bedId))
  const people = await personMap(actor, [...exts, ...outs].map(r => ({ staffId: r.staffId, siteId: r.siteId })))
  return {
    extensions: exts.map(e => ({
      id: e.id, stayId: e.stayId, staffId: e.staffId, name: personOf(people, e.staffId).name, bedLabel: beds.get(bedOfStay.get(e.stayId) ?? '')?.label ?? '', currentEnd: e.currentEnd, newEnd: e.newEnd,
      addedDays: e.addedDays, beyondPolicy: e.beyondPolicy, reason: e.reason, createdAt: e.createdAt.toISOString(), clash: (e.clash as PendingExtension['clash']) ?? null,
      canDecide: (e.beyondPolicy ? can(actor, 'reservations_stays.approve_extension_beyond_policy', { siteId: e.siteId }) : can(actor, 'reservations_stays.approve_extension', { siteId: e.siteId }))
        && actor.staffId !== e.staffId && actor.staffId !== e.requestedByStaffId,
    })),
    checkouts: outs.map(o => ({
      id: o.id, stayId: o.stayId, staffId: o.staffId, name: personOf(people, o.staffId).name, bedLabel: beds.get(bedOfStay.get(o.stayId) ?? '')?.label ?? '', departureDate: o.departureDate,
      note: o.note, status: o.status, createdAt: o.createdAt.toISOString(), canProcess: can(actor, 'checkin_checkout.execute', { siteId: o.siteId }) && actor.staffId !== o.staffId,
    })),
  }
}
