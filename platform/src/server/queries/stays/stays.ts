import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { bed, bedClaim, reservation, stay } from '@/server/db/schema'
import { checkoutRequest, extensionRequest, transferRequest } from '@/server/db/schema.stays'
import { getDb } from '@/server/db/client'
import { getConfig } from '@/server/config/registry'
import { can, scopeFilter, type Actor } from '@/server/policy'
import { getClock } from '@/server/runtime'
import { isUuid } from '@/server/commands/property/shared'
import { stayFlag, type StayFlag } from '@/server/commands/stays/rules'
import { scopeSql } from '@/server/queries/scope'
import { suggestBeds, type BedSuggestion } from '@/server/allocation'
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
  const transfers: TransferView[] = trs.map(t => ({
    id: t.id, kind: t.kind, status: t.status, reason: t.reason, fromBedLabel: beds.get(t.fromBedId)?.label ?? '', toBedLabel: t.toBedId ? beds.get(t.toBedId)?.label ?? null : null,
    createdAt: t.createdAt.toISOString(), executedAt: t.executedAt?.toISOString() ?? null, failureReason: t.failureReason, failedAt: t.failedAt?.toISOString() ?? null,
  }))
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

/** Beds that are ready right now and free for the rest of this stay: what a transfer request can offer. Same site only. */
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
