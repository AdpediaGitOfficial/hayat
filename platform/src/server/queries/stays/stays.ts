import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { bed, bedClaim, reservation, room, site, stay } from '@/server/db/schema'
import { checkoutRequest, extensionRequest, transferRequest } from '@/server/db/schema.stays'
import { getDb } from '@/server/db/client'
import { getConfig } from '@/server/config/registry'
import { can, scopeFilter, type Actor } from '@/server/policy'
import { getClock } from '@/server/runtime'
import { isUuid } from '@/server/commands/property/shared'
import { stayFlag, type StayFlag } from '@/server/commands/stays/rules'
import { scopeSql } from '@/server/queries/scope'
import { suggestBeds, type BedSuggestion } from '@/server/allocation'
import { checkEligibility } from '@/server/eligibility'
import { bedInfoMap, localDate, personMap, personOf } from './common'

export interface StayRow {
  id: string
  staffId: string
  name: string
  employeeId: string
  status: string
  stayType: string
  siteId: string
  siteName: string
  bedId: string
  bedLabel: string
  bedState: string
  from: string
  to: string | null
  checkedInAt: string
  checkedOutAt: string | null
  flag: StayFlag
  daysLeft: number | null
  daysOver: number
  /** The overdue stay has been escalated to the Policy Approver (D-56). Still active: nobody is ever checked out automatically. */
  escalated: boolean
}

export interface StayFilters { siteId?: string; staffId?: string; status?: string; flag?: 'overdue' | 'ending' | 'attention'; limit?: number; offset?: number }

/** Stays the actor may see (`reservations_stays.view`: their sites, or only their own for a resident), with the ending/overdue badge. */
export async function listStays(actor: Actor, f: StayFilters = {}, now: Date = getClock().now()): Promise<{ rows: StayRow[]; total: number }> {
  const db = getDb()
  const status = f.status ?? 'active'
  const raw = await db.select({
    id: stay.id, staffId: stay.staffId, bedId: stay.bedId, status: stay.status, stayType: stay.stayType, checkedInAt: stay.checkedInAt, checkedOutAt: stay.checkedOutAt, siteId: bed.siteId,
    from: sql<string>`lower(${bedClaim.period})::text`, to: sql<string | null>`upper(${bedClaim.period})::text`,
  }).from(stay).innerJoin(bed, eq(bed.id, stay.bedId)).innerJoin(bedClaim, eq(bedClaim.id, stay.claimId))
    .where(and(
      scopeSql(scopeFilter(actor, 'reservations_stays.view'), { site: bed.siteId, owner: stay.staffId }),
      status === 'all' ? undefined : status === 'occupying' ? inArray(stay.status, ['provisional', 'active', 'resolution_pending']) : eq(stay.status, status as 'active'),
      f.siteId ? eq(bed.siteId, f.siteId) : undefined,
      f.staffId ? eq(stay.staffId, f.staffId) : undefined,
    )).orderBy(desc(stay.checkedInAt)).limit(1000)
  if (raw.length === 0) return { rows: [], total: 0 }

  const [beds, people, grace] = [await bedInfoMap(raw.map(r => r.bedId)), await personMap(actor, raw), await getConfig(db, 'timers.overdue_grace_days')]
  let rows: StayRow[] = raw.map(r => {
    const b = beds.get(r.bedId)!
    const p = personOf(people, r.staffId)
    const today = localDate(now, b.siteTimeZone)
    const fl = r.status === 'active' ? stayFlag(r.to, today, grace) : { flag: 'ok' as const, daysLeft: null, daysOver: 0 }
    return {
      id: r.id, staffId: r.staffId, name: p.name, employeeId: p.employeeId, status: r.status, stayType: r.stayType, siteId: r.siteId, siteName: b.siteName,
      bedId: r.bedId, bedLabel: b.label, bedState: b.state, from: r.from, to: r.to, checkedInAt: r.checkedInAt.toISOString(), checkedOutAt: r.checkedOutAt?.toISOString() ?? null,
      flag: fl.flag, daysLeft: fl.daysLeft, daysOver: fl.daysOver, escalated: fl.flag === 'escalated',
    }
  })
  if (f.flag === 'overdue') rows = rows.filter(r => r.flag === 'overdue' || r.flag === 'escalated')
  else if (f.flag === 'ending') rows = rows.filter(r => r.flag === 'ending')
  else if (f.flag === 'attention') rows = rows.filter(r => r.flag !== 'ok')
  // Most urgent first: escalated, overdue, ending soonest, then the rest by name.
  const rank: Record<StayFlag, number> = { escalated: 0, overdue: 1, ending: 2, ok: 3 }
  rows.sort((a, b) => rank[a.flag] - rank[b.flag] || (a.to ?? '9999').localeCompare(b.to ?? '9999') || a.name.localeCompare(b.name))
  const total = rows.length
  return { rows: rows.slice(f.offset ?? 0, (f.offset ?? 0) + (f.limit ?? 50)), total }
}

/* ---------------- detail ---------------- */

export interface ExtensionView {
  id: string; status: string; currentEnd: string; newEnd: string; addedDays: number; beyondPolicy: boolean; reason: string | null
  route: 'accommodation_admin' | 'policy_approver'; createdAt: string; decidedAt: string | null; decisionReason: string | null
  clash: unknown | null; requestedByStaffId: string | null
}
export interface CheckoutView { id: string; status: string; departureDate: string; note: string | null; createdAt: string; acknowledgedAt: string | null; completedAt: string | null }
export interface TransferView {
  id: string; kind: 'transfer' | 'swap'; status: string; reason: string; fromBedLabel: string; toBedLabel: string | null; createdAt: string; executedAt: string | null
  failureReason: string | null; failedAt: string | null
  /** D-104: a move into another site needs the Accommodation Admin of each site (the two keys). */
  crossSite: boolean
  fromSiteName: string
  toSiteName: string
  keys: { source: { siteName: string; approved: boolean }; destination: { siteName: string; approved: boolean } }
  /** While open and cross-site: who still has to approve, in words ("the Accommodation Admin of Palm Villas"). */
  waitingFor: string | null
}
export interface StayDetail extends StayRow {
  reservationId: string | null
  siteTimeZone: string
  extensions: ExtensionView[]
  checkouts: CheckoutView[]
  transfers: TransferView[]
  /** Open requests by kind, for the action panel. */
  openExtension?: ExtensionView
  openCheckout?: CheckoutView
  openTransfer?: TransferView
  policyDays: number
}

export async function getStayDetail(actor: Actor, id: string, now: Date = getClock().now()): Promise<StayDetail | undefined> {
  if (!isUuid(id)) return undefined
  const db = getDb()
  const { rows } = await listStaysByIds(actor, [id], now)
  const base = rows[0]
  if (!base) return undefined
  const [res] = await db.select({ id: reservation.id }).from(stay).leftJoin(reservation, eq(reservation.id, stay.reservationId)).where(eq(stay.id, id)).limit(1)
  const [ext, outs, trs] = [
    await db.select().from(extensionRequest).where(eq(extensionRequest.stayId, id)).orderBy(desc(extensionRequest.createdAt)).limit(10),
    await db.select().from(checkoutRequest).where(eq(checkoutRequest.stayId, id)).orderBy(desc(checkoutRequest.createdAt)).limit(10),
    await db.select().from(transferRequest).where(sql`${transferRequest.stayId} = ${id} OR ${transferRequest.otherStayId} = ${id}`).orderBy(desc(transferRequest.createdAt)).limit(10),
  ]
  const beds = await bedInfoMap([...trs.flatMap(t => [t.fromBedId, t.toBedId].filter((x): x is string => !!x)), base.bedId])
  const info = beds.get(base.bedId)!
  const extensions: ExtensionView[] = ext.map(e => ({
    id: e.id, status: e.status, currentEnd: e.currentEnd, newEnd: e.newEnd, addedDays: e.addedDays, beyondPolicy: e.beyondPolicy, reason: e.reason,
    route: e.beyondPolicy ? 'policy_approver' : 'accommodation_admin', createdAt: e.createdAt.toISOString(), decidedAt: e.decidedAt?.toISOString() ?? null, decisionReason: e.decisionReason,
    clash: e.clash ?? null, requestedByStaffId: e.requestedByStaffId,
  }))
  const checkouts: CheckoutView[] = outs.map(o => ({ id: o.id, status: o.status, departureDate: o.departureDate, note: o.note, createdAt: o.createdAt.toISOString(), acknowledgedAt: o.acknowledgedAt?.toISOString() ?? null, completedAt: o.completedAt?.toISOString() ?? null }))
  const siteIds = [...new Set(trs.flatMap(t => [t.siteId, t.destinationSiteId]))]
  const siteNames = new Map((siteIds.length ? await db.select({ id: site.id, name: site.name }).from(site).where(inArray(site.id, siteIds)) : []).map(s => [s.id, s.name]))
  const transfers: TransferView[] = trs.map(t => {
    const crossSite = t.destinationSiteId !== t.siteId
    const [fromSiteName, toSiteName] = [siteNames.get(t.siteId) ?? '', siteNames.get(t.destinationSiteId) ?? '']
    const missing = t.status === 'requested' || t.status === 'failed'
      ? [t.sourceApprovedAt ? null : fromSiteName, t.destinationApprovedAt ? null : toSiteName].filter((x): x is string => x !== null) : []
    return {
      id: t.id, kind: t.kind, status: t.status, reason: t.reason, fromBedLabel: beds.get(t.fromBedId)?.label ?? '', toBedLabel: t.toBedId ? beds.get(t.toBedId)?.label ?? null : null,
      createdAt: t.createdAt.toISOString(), executedAt: t.executedAt?.toISOString() ?? null, failureReason: t.failureReason, failedAt: t.failedAt?.toISOString() ?? null,
      crossSite, fromSiteName, toSiteName,
      keys: { source: { siteName: fromSiteName, approved: !!t.sourceApprovedAt }, destination: { siteName: toSiteName, approved: !!t.destinationApprovedAt } },
      waitingFor: crossSite && missing.length ? missing.map(n => `the Accommodation Admin of ${n}`).join(' and ') : null,
    }
  })
  return {
    ...base, reservationId: res?.id ?? null, siteTimeZone: info.siteTimeZone, extensions, checkouts, transfers,
    openExtension: extensions.find(e => e.status === 'requested'),
    openCheckout: checkouts.find(o => o.status === 'requested' || o.status === 'acknowledged'),
    openTransfer: transfers.find(t => ['requested', 'approved', 'failed'].includes(t.status)),
    policyDays: await getConfig(db, 'stays.extension_policy_days'),
  }
}

async function listStaysByIds(actor: Actor, ids: string[], now: Date) {
  const db = getDb()
  const raw = await db.select({
    id: stay.id, staffId: stay.staffId, bedId: stay.bedId, status: stay.status, stayType: stay.stayType, checkedInAt: stay.checkedInAt, checkedOutAt: stay.checkedOutAt, siteId: bed.siteId,
    from: sql<string>`lower(${bedClaim.period})::text`, to: sql<string | null>`upper(${bedClaim.period})::text`,
  }).from(stay).innerJoin(bed, eq(bed.id, stay.bedId)).innerJoin(bedClaim, eq(bedClaim.id, stay.claimId))
    .where(and(inArray(stay.id, ids), scopeSql(scopeFilter(actor, 'reservations_stays.view'), { site: bed.siteId, owner: stay.staffId })))
  if (raw.length === 0) return { rows: [] as StayRow[] }
  const [beds, people, grace] = [await bedInfoMap(raw.map(r => r.bedId)), await personMap(actor, raw), await getConfig(db, 'timers.overdue_grace_days')]
  const rows = raw.map(r => {
    const b = beds.get(r.bedId)!
    const p = personOf(people, r.staffId)
    const fl = r.status === 'active' ? stayFlag(r.to, localDate(now, b.siteTimeZone), grace) : { flag: 'ok' as const, daysLeft: null, daysOver: 0 }
    return {
      id: r.id, staffId: r.staffId, name: p.name, employeeId: p.employeeId, status: r.status, stayType: r.stayType, siteId: r.siteId, siteName: b.siteName,
      bedId: r.bedId, bedLabel: b.label, bedState: b.state, from: r.from, to: r.to, checkedInAt: r.checkedInAt.toISOString(), checkedOutAt: r.checkedOutAt?.toISOString() ?? null,
      flag: fl.flag, daysLeft: fl.daysLeft, daysOver: fl.daysOver, escalated: fl.flag === 'escalated',
    } satisfies StayRow
  })
  return { rows }
}

/** What the viewer can do about a stay, from the policy (the commands re-check everything). */
export function stayAbilities(actor: Actor, s: { siteId: string; staffId: string }) {
  const own = { siteId: s.siteId, ownerStaffId: s.staffId }
  const mine = actor.staffId === s.staffId
  return {
    requestExtension: can(actor, 'reservations_stays.request_extension', own) || can(actor, 'reservations_stays.approve_extension', own),
    requestCheckout: can(actor, 'reservations_stays.request_checkout', own),
    requestTransfer: can(actor, 'transfers_swaps.request', own) || can(actor, 'transfers_swaps.approve', own),
    processCheckout: can(actor, 'checkin_checkout.execute', own) && !mine,
    approveTransfer: can(actor, 'transfers_swaps.approve', own),
    executeTransfer: can(actor, 'transfers_swaps.execute', own),
    approveExtension: can(actor, 'reservations_stays.approve_extension', own),
    approveExtensionBeyond: can(actor, 'reservations_stays.approve_extension_beyond_policy', own),
    mine,
  }
}

/* ---------------- where a move can go (D-104) ---------------- */

export interface DestinationSite { id: string; name: string; current: boolean }
export interface DestinationBed { bedId: string; code: string; roomName: string; eligible: boolean; /** Plain words, about the person being moved only. */ hint: string | null }
export interface DestinationOptions { siteId: string; siteName: string; current: boolean; beds: DestinationBed[]; note: string | null }

/** Every live site a move can go to: the requester needs no scope there, because the Accommodation Admin of that site decides. */
export async function transferSites(currentSiteId: string): Promise<DestinationSite[]> {
  const rows = await getDb().select({ id: site.id, name: site.name }).from(site).where(sql`${site.archivedAt} is null`).orderBy(site.name)
  return rows.map(r => ({ ...r, current: r.id === currentSiteId }))
}

/**
 * The beds of a destination site that are ready now and free for the rest of this stay, each with whether this person may have it
 * under THAT site's rules and, if not, why in plain words. Only for someone who may ask for the move; no other person's data.
 */
export async function destinationOptions(actor: Actor, stayId: string, siteId: string, now: Date = getClock().now()): Promise<DestinationOptions | undefined> {
  if (!isUuid(stayId) || !isUuid(siteId)) return undefined
  const { rows } = await listStaysByIds(actor, [stayId], now)
  const s = rows[0]
  if (!s || s.status !== 'active') return undefined
  const ab = stayAbilities(actor, { siteId: s.siteId, staffId: s.staffId })
  if (!ab.requestTransfer) return undefined
  const db = getDb()
  const [dest] = await db.select({ id: site.id, name: site.name, tz: site.timeZone, archivedAt: site.archivedAt }).from(site).where(eq(site.id, siteId)).limit(1)
  if (!dest || dest.archivedAt) return undefined
  const today = localDate(now, dest.tz)
  const from = today > s.from ? today : s.from
  if (s.to && s.to <= from) return { siteId, siteName: dest.name, current: siteId === s.siteId, beds: [], note: 'This stay ends before a move could happen.' }
  const period = `[${from},${s.to ?? ''})`
  const candidates = await db.select({ bedId: bed.id, code: bed.code, roomName: room.name }).from(bed).innerJoin(room, eq(room.id, bed.roomId))
    .where(and(
      eq(bed.siteId, siteId), eq(bed.state, 'available'), sql`${bed.archivedAt} is null`, sql`${room.archivedAt} is null`, sql`${bed.id} <> ${s.bedId}`,
      sql`NOT EXISTS (SELECT 1 FROM ${bedClaim} WHERE ${bedClaim.bedId} = ${bed.id} AND ${bedClaim.releasedAt} IS NULL AND ${bedClaim.period} && ${period}::daterange)`,
    )).orderBy(room.name, bed.code).limit(40)
  const beds: DestinationBed[] = []
  for (const cand of candidates) {
    const e = await checkEligibility(db, s.staffId, cand.bedId, now)
    beds.push({ ...cand, eligible: !!e?.ok, hint: !e || e.ok ? null : `${e.reasons.join('; ')}${e.exceptionable ? '. A Policy Approver can grant an exception.' : ''}` })
  }
  beds.sort((a, b) => Number(b.eligible) - Number(a.eligible))
  return {
    siteId, siteName: dest.name, current: siteId === s.siteId, beds,
    note: beds.length === 0 ? `No ready bed in ${dest.name} is free for the rest of this stay. You can still ask for "any suitable bed": the Accommodation Admin there will look.` : null,
  }
}

/** Beds that are ready right now and free for the rest of this stay in the SAME site: what a transfer request can offer first. */
export async function transferOptions(actor: Actor, stayId: string, now: Date = getClock().now()): Promise<BedSuggestion[]> {
  if (!isUuid(stayId)) return []
  const { rows } = await listStaysByIds(actor, [stayId], now)
  const s = rows[0]
  if (!s || s.status !== 'active') return []
  const today = localDate(now, (await bedInfoMap([s.bedId])).get(s.bedId)?.siteTimeZone ?? 'UTC')
  const from = today > s.from ? today : s.from
  if (s.to && s.to <= from) return []
  return (await suggestBeds(getDb(), { staffId: s.staffId, siteId: s.siteId, from, to: s.to ?? undefined, limit: 12, excludeBedIds: [s.bedId], now })).filter(b => b.state === 'available').slice(0, 8)
}
