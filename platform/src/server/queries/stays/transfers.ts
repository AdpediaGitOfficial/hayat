import { and, desc, eq, inArray, or, sql } from 'drizzle-orm'
import { site, staffProfile, stay } from '@/server/db/schema'
import { checkoutRequest, extensionRequest, transferRequest } from '@/server/db/schema.stays'
import { getDb } from '@/server/db/client'
import { can, scopeFilter, type Actor } from '@/server/policy'
import { getClock } from '@/server/runtime'
import { getConfig } from '@/server/config/registry'
import { suggestBeds, type BedSuggestion } from '@/server/allocation'
import { checkEligibility } from '@/server/eligibility'
import { claimPeriod } from '@/domain/claims'
import { bed as bedTable, room } from '@/server/db/schema'
import { exceptionNeeds, type ExceptionNeed } from '@/server/commands/stays/transferException'
import { scopeSql } from '@/server/queries/scope'
import { bedInfoMap, localDate, personMap, personOf } from './common'

/** One of the two approvals a move needs (D-104). A same-site request has both, given by one decision. */
export interface ApprovalKey {
  /** The site that owns this key. */
  siteId: string
  siteName: string
  approved: boolean
  at: string | null
  /** The viewer could give this key right now (their scope, not involved in the request). */
  viewerCanGive: boolean
}
/** What an open request is waiting for, in words that name the owner and the next action (never a dead end). */
export interface WaitingFor { text: string; owner: string; next: string }

/**
 * A person of the move whose destination bed fails a gender or grade rule of the destination site (P-10, PROPOSED, pending client sign-off).
 * Shown only while `transfers.exception_path` is on. `waiting`: a Policy Approver of that site can decide; `declined`: they did, for
 * this bed; `blocked`: not waivable (a left employee).
 */
export interface ExceptionView {
  staffId: string
  name: string
  party: 'first' | 'second'
  bedLabel: string
  siteId: string
  siteName: string
  state: ExceptionNeed['state']
  failed: ('gender' | 'grade')[]
  reasons: string[]
  declinedReason: string | null
  /** The viewer is a Policy Approver of that site and not part of the move or its raiser. The command checks again and asks for the password. */
  viewerCanDecide: boolean
}

export interface TransferListRow {
  id: string
  kind: 'transfer' | 'swap'
  status: string
  /** The SOURCE site. */
  siteId: string
  siteName: string
  destinationSiteId: string
  destinationSiteName: string
  crossSite: boolean
  /** The two approvals (D-104). */
  keys: { source: ApprovalKey; destination: ApprovalKey }
  /** Set while the request is open and a key is missing, or approved and waiting for Reception. */
  waiting: WaitingFor | null
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
  /** Raised for the resident by someone else (an Accommodation Admin, or Reception when P-09 is on). Null = the resident asked. */
  raisedBy: { name: string } | null
  /** Destination checks that need a Policy Approver (P-10). Empty when the setting is off or everyone passes. */
  exceptions: ExceptionView[]
  /** P-10 in force (the setting is on). */
  exceptionPath: boolean
  /**
   * Beds of the destination site that are ready and free but fail a gender or grade rule that a Policy Approver may waive (P-10, proposed,
   * pending client sign-off). Listed for whoever chooses the bed, so the choice can be made WITH the exception asked for. Empty otherwise.
   */
  askableBeds: { bedId: string; label: string; roomName: string; code: string; reasons: string[] }[]
  /** Set when the viewer is one of the two residents in a swap (resident mode): they answer for themselves. */
  viewerParty: 'a' | 'b' | null
  /** `approve` = the viewer can give at least one missing key; `chooseBed` = they give the destination key, so they pick the bed. */
  can: { approve: boolean; execute: boolean; consent: boolean; cancel: boolean; chooseBed: boolean }
}

export interface TransferFilters { status?: string; siteId?: string; limit?: number }

/** Transfers and swaps the actor may see (`transfers_swaps.view`: their sites, or those they are part of). Open ones first. */
export async function listTransfers(actor: Actor, f: TransferFilters = {}, now: Date = getClock().now()): Promise<TransferListRow[]> {
  const db = getDb()
  const sf = scopeFilter(actor, 'transfers_swaps.view')
  // A cross-site request belongs to BOTH sites (D-104): the Accommodation Admin of either sees it. Nothing here widens scope: a site
  // the actor has no grant for contributes nothing, and a request that touches none of their sites is never fetched.
  const scope = scopeSql(sf, { site: transferRequest.siteId, owner: transferRequest.staffId })
  const scopeDestination = scopeSql(sf, { site: transferRequest.destinationSiteId })
  const alsoOther = sf.kind === 'restricted' && sf.ownerStaffId ? eq(transferRequest.otherStaffId, sf.ownerStaffId) : undefined
  const visible = [scope, scopeDestination, alsoOther].filter(x => x !== undefined)
  const raw = await db.select().from(transferRequest)
    .where(and(
      sf.kind === 'all' ? undefined : or(...visible),
      f.status === 'open' ? inArray(transferRequest.status, ['requested', 'approved', 'failed']) : f.status ? eq(transferRequest.status, f.status as 'requested') : undefined,
      f.siteId ? or(eq(transferRequest.siteId, f.siteId), eq(transferRequest.destinationSiteId, f.siteId)) : undefined,
    ))
    .orderBy(sql`(${transferRequest.status} in ('requested','approved','failed')) desc`, desc(transferRequest.createdAt)).limit(f.limit ?? 100)
  if (raw.length === 0) return []

  const beds = await bedInfoMap(raw.flatMap(t => [t.fromBedId, t.toBedId].filter((x): x is string => !!x)))
  const siteIds = [...new Set(raw.flatMap(t => [t.siteId, t.destinationSiteId]))]
  const sites = new Map((await db.select({ id: site.id, name: site.name, tz: site.timeZone }).from(site).where(inArray(site.id, siteIds))).map(s => [s.id, s]))
  // Names are staff data: whoever may look people up at EITHER site of the move (the admin who approves the other end needs to know who is coming).
  const people = await personMap(actor, raw.flatMap(t => [t.staffId, ...(t.otherStaffId ? [t.otherStaffId] : []), ...(t.requestedByStaffId ? [t.requestedByStaffId] : [])].flatMap(staffId => [
    { staffId, siteId: t.siteId }, ...(t.destinationSiteId !== t.siteId ? [{ staffId, siteId: t.destinationSiteId }] : []),
  ])))
  const exceptionPath = await getConfig(db, 'transfers.exception_path')
  const stays = await db.select({ id: stay.id, claim: sql<string | null>`upper((select period from bed_claim where id = ${stay.claimId}))::text` }).from(stay).where(inArray(stay.id, raw.map(t => t.stayId)))
  const endOf = new Map(stays.map(s => [s.id, s.claim]))

  const out: TransferListRow[] = []
  for (const t of raw) {
    const open = t.status === 'requested' || t.status === 'failed'
    const info = beds.get(t.fromBedId)
    const crossSite = t.destinationSiteId !== t.siteId
    const [srcSite, dstSite] = [sites.get(t.siteId), sites.get(t.destinationSiteId)]
    const myPart = actor.staffId !== undefined && (actor.staffId === t.staffId || actor.staffId === t.otherStaffId)
    const involved = myPart || actor.staffId === t.requestedByStaffId
    // May the viewer give the key of a site? The Accommodation Admin of that site, or a backup approver / Policy Approver there (the
    // command decides, from the SLA clock, whether it is their turn yet).
    const giveAt = (siteId: string) => open && !involved && (can(actor, 'transfers_swaps.approve', { siteId }) || can(actor, 'approvals_inbox.decide_escalated', { siteId }))
    const key = (siteId: string, name: string, at: Date | null): ApprovalKey => ({ siteId, siteName: name, approved: !!at, at: at?.toISOString() ?? null, viewerCanGive: !at && giveAt(siteId) })
    const keys = {
      source: key(t.siteId, srcSite?.name ?? '', t.sourceApprovedAt),
      destination: key(t.destinationSiteId, dstSite?.name ?? '', t.destinationApprovedAt),
    }
    let suggestions: BedSuggestion[] = []
    // The destination site's admin picks the bed there: suggest beds of THAT site, to whoever can give that key (everyone, for a same-site move, as before).
    if (t.kind === 'transfer' && open && info && (!crossSite || keys.destination.viewerCanGive)) {
      const today = localDate(now, dstSite?.tz ?? info.siteTimeZone)
      const to = endOf.get(t.stayId) ?? undefined
      if (!to || to > today) {
        suggestions = (await suggestBeds(db, { staffId: t.staffId, siteId: t.destinationSiteId, from: today, to: to ?? undefined, limit: 8, excludeBedIds: [t.fromBedId], transferId: t.id, now })).filter(b => b.state === 'available').slice(0, 5)
      }
    }
    const needs = exceptionPath && (t.status === 'requested' || t.status === 'approved' || t.status === 'failed') ? await exceptionNeeds(db, t, now) : []
    const exceptions: ExceptionView[] = needs.map(n => ({
      staffId: n.staffId, name: personOf(people, n.staffId).name, party: n.party, bedLabel: beds.get(n.bedId)?.label ?? '', siteId: n.siteId, siteName: sites.get(n.siteId)?.name ?? '',
      state: n.state, failed: n.failed, reasons: n.reasons, declinedReason: n.declinedReason ?? null,
      viewerCanDecide: n.state === 'waiting' && can(actor, 'requests_waitlist.approve_exception', { siteId: n.siteId })
        && ![t.staffId, t.otherStaffId, t.requestedByStaffId].some(x => !!x && x === actor.staffId),
    }))
    // A Policy Approver who has to decide on someone is told who it is, as the approvals inbox already does (the name is not directory data for them).
    for (const e of exceptions) {
      if (e.viewerCanDecide && e.name === 'Resident') {
        const [p] = await db.select({ n: staffProfile.fullName }).from(staffProfile).where(eq(staffProfile.id, e.staffId)).limit(1)
        if (p) e.name = p.n
      }
    }
    let askableBeds: TransferListRow['askableBeds'] = []
    if (exceptionPath && t.kind === 'transfer' && open && info && keys.destination.viewerCanGive) {
      const today = localDate(now, dstSite?.tz ?? info.siteTimeZone)
      const to = endOf.get(t.stayId) ?? undefined
      if (!to || to > today) askableBeds = await askable(db, t, today, to, now)
    }
    const waiting = exceptionWaiting(exceptions) ?? waitingOf(t, keys, crossSite)
    out.push({
      id: t.id, kind: t.kind, status: t.status, siteId: t.siteId, siteName: srcSite?.name ?? '', destinationSiteId: t.destinationSiteId, destinationSiteName: dstSite?.name ?? '',
      crossSite, keys, waiting,
      stayId: t.stayId, otherStayId: t.otherStayId, staffId: t.staffId, otherStaffId: t.otherStaffId,
      name: personOf(people, t.staffId).name, otherName: t.otherStaffId ? personOf(people, t.otherStaffId).name : null,
      fromBedLabel: info?.label ?? '', toBedId: t.toBedId, toBedLabel: t.toBedId ? beds.get(t.toBedId)?.label ?? null : null,
      reason: t.reason, neededBy: t.neededBy, createdAt: t.createdAt.toISOString(), requestedByStaffId: t.requestedByStaffId,
      consent: t.kind === 'swap' ? { a: !!t.consentAAt, b: !!t.consentBAt } : null,
      failureReason: t.status === 'failed' ? t.failureReason : null,
      failureNext: t.status === 'failed' ? ((t.failureDetail as { next?: string } | null)?.next ?? null) : null,
      failedAt: t.failedAt?.toISOString() ?? null, executedAt: t.executedAt?.toISOString() ?? null, decisionReason: t.decisionReason,
      suggestions, exceptions, exceptionPath, askableBeds,
      raisedBy: t.requestedByStaffId && t.requestedByStaffId !== t.staffId && t.requestedByStaffId !== t.otherStaffId ? { name: personOf(people, t.requestedByStaffId).name } : null,
      viewerParty: t.kind === 'swap' && actor.role === 'Res' && actor.staffId ? (actor.staffId === t.staffId ? 'a' : actor.staffId === t.otherStaffId ? 'b' : null) : null,
      can: {
        approve: keys.source.viewerCanGive || keys.destination.viewerCanGive,
        chooseBed: t.kind === 'transfer' && keys.destination.viewerCanGive,
        // Reception or an Accommodation Admin with scope on EITHER site, once both approvals are in.
        execute: t.status === 'approved' && (can(actor, 'transfers_swaps.execute', { siteId: t.siteId }) || can(actor, 'transfers_swaps.execute', { siteId: t.destinationSiteId })) && !myPart,
        consent: t.kind === 'swap' && t.status === 'requested' && (myPart && actor.role === 'Res' || either(actor, 'transfers_swaps.approve', t.siteId, t.destinationSiteId)),
        cancel: ['requested', 'approved', 'failed'].includes(t.status) && (myPart || either(actor, 'transfers_swaps.approve', t.siteId, t.destinationSiteId)),
      },
    })
  }
  return out
}

const either = (actor: Actor, action: 'transfers_swaps.approve', a: string, b: string) => can(actor, action, { siteId: a }) || can(actor, action, { siteId: b })

/** Ready, free beds of the destination site that this person fails only by a rule a Policy Approver may waive (P-10, proposed, pending client sign-off). */
async function askable(db: ReturnType<typeof getDb>, t: typeof transferRequest.$inferSelect, from: string, to: string | undefined, now: Date): Promise<TransferListRow['askableBeds']> {
  const period = claimPeriod(from, to)
  const candidates = await db.select({ bedId: bedTable.id, code: bedTable.code, roomName: room.name }).from(bedTable).innerJoin(room, eq(room.id, bedTable.roomId))
    .where(and(
      eq(bedTable.siteId, t.destinationSiteId), eq(bedTable.state, 'available'), sql`${bedTable.archivedAt} is null`, sql`${room.archivedAt} is null`, sql`${bedTable.id} <> ${t.fromBedId}`,
      sql`NOT EXISTS (SELECT 1 FROM bed_claim c WHERE c.bed_id = ${bedTable.id} AND c.released_at IS NULL AND c.period && ${period}::daterange)`,
    )).orderBy(room.name, bedTable.code).limit(40)
  const out: TransferListRow['askableBeds'] = []
  for (const cand of candidates) {
    const e = await checkEligibility(db, t.staffId, cand.bedId, now, { transferId: t.id })
    if (e && !e.ok && e.exceptionable) out.push({ bedId: cand.bedId, label: `${cand.roomName} · ${cand.code}`, roomName: cand.roomName, code: cand.code, reasons: e.reasons })
    if (out.length >= 8) break
  }
  return out
}

/** A destination that needs a Policy Approver comes first: nothing else can be finished before that decision. */
function exceptionWaiting(list: ExceptionView[]): WaitingFor | null {
  const w = list.find(e => e.state === 'waiting')
  if (w) {
    return {
      text: `Waiting for a Policy Approver exception: ${w.reasons.join('; ')}`, owner: `Policy Approver of ${w.siteName}`,
      next: `A Policy Approver of ${w.siteName} records the exception with evidence, or declines it. Until then this move cannot go ahead. Proposed policy, pending client sign-off`,
    }
  }
  const d = list.find(e => e.state === 'declined')
  if (d) return { text: `A Policy Approver declined the exception: ${d.declinedReason ?? ''}`.trim(), owner: `Accommodation Admin of ${d.siteName}`, next: 'Choose another bed, or reject the move' }
  return null
}

/** Plain words for what an unfinished request is waiting for: who owns the next step and what they do. Null once it is done or dead. */
function waitingOf(t: typeof transferRequest.$inferSelect, keys: { source: ApprovalKey; destination: ApprovalKey }, crossSite: boolean): WaitingFor | null {
  if (t.status === 'approved') {
    return { text: 'Approved: waiting for Reception to carry it out', owner: 'Reception', next: 'Reception moves the resident when they are ready' }
  }
  if (t.status !== 'requested' && t.status !== 'failed') return null
  const missing = [!keys.source.approved && keys.source, !keys.destination.approved && keys.destination].filter((k): k is ApprovalKey => !!k)
  if (missing.length === 0) return null
  if (!crossSite) {
    return { text: 'Waiting for an Accommodation Admin', owner: 'Accommodation Admin', next: 'An Accommodation Admin who is not part of the request approves it from the approvals inbox' }
  }
  const owners = missing.map(k => `the Accommodation Admin of ${k.siteName}`)
  const dst = missing.includes(keys.destination)
  return {
    text: `Waiting for ${owners.join(' and ')}`,
    owner: missing.map(k => `Accommodation Admin of ${k.siteName}`).join(' and '),
    next: `${owners.join(' and ')} approves it${dst && t.kind === 'transfer' ? ` and chooses the bed in ${keys.destination.siteName}` : ''}; nobody moves until both sites have approved`,
  }
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
