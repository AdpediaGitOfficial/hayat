import { and, eq, isNull, sql } from 'drizzle-orm'
import { bed, bedClaim, reservation } from '@/server/db/schema'
import { getDb } from '@/server/db/client'
import { getConfig } from '@/server/config/registry'
import { scopeFilter, type Actor } from '@/server/policy'
import { getClock } from '@/server/runtime'
import { arrivalView, noShowDeadlineMs, readinessBlock, type ArrivalView } from '@/server/commands/stays/rules'
import { scopeSql } from '@/server/queries/scope'
import { bedInfoMap, localDate, personMap, personOf } from './common'

export interface ArrivalRow {
  reservationId: string
  staffId: string
  name: string
  employeeId: string
  siteId: string
  siteName: string
  bedId: string
  bedCode: string
  bedLabel: string
  bedState: string
  from: string
  to: string | null
  eta: string
  /** When the no-show rule will release this hold if nobody arrives (D-58). */
  noShowAfter: string
  noShowExtended: boolean
  view: ArrivalView
  /** Arrival day reached (today or earlier) = ready to be checked in; otherwise expected later. */
  due: boolean
  /** Why check-in would be refused right now: reason, owner, next action (D-93). Absent when the bed is ready. */
  block?: { reason: string; owner: string; next: string; code: string }
}

/**
 * Reservations still waiting to check in, for Reception's arrivals screen: today's and overdue arrivals first, then those
 * expected within `horizonDays`. "Not ready" is shown the moment the arrival day comes and the bed is not Available; a bed
 * still being cleaned for a LATER arrival is just Expected (readiness gates check-in only, D-18).
 */
export async function listArrivals(actor: Actor, o: { siteId?: string; horizonDays?: number } = {}, now: Date = getClock().now()): Promise<ArrivalRow[]> {
  const db = getDb()
  const horizon = o.horizonDays ?? 7
  const rows = await db.select({
    reservationId: reservation.id, staffId: reservation.staffId, bedId: reservation.bedId, eta: reservation.eta, extended: reservation.noShowExtended, siteId: bed.siteId,
    from: sql<string>`lower(${bedClaim.period})::text`, to: sql<string | null>`upper(${bedClaim.period})::text`,
  }).from(reservation).innerJoin(bed, eq(bed.id, reservation.bedId)).innerJoin(bedClaim, eq(bedClaim.id, reservation.claimId))
    .where(and(
      eq(reservation.status, 'reserved'), isNull(reservation.archivedAt),
      scopeSql(scopeFilter(actor, 'checkin_checkout.view'), { site: bed.siteId }),
      o.siteId ? eq(bed.siteId, o.siteId) : undefined,
      sql`lower(${bedClaim.period}) <= (${now.toISOString()}::timestamptz + ${`${horizon + 1} days`}::interval)::date`,
    )).limit(500)
  if (rows.length === 0) return []

  const [beds, people, noShowHours] = [await bedInfoMap(rows.map(r => r.bedId)), await personMap(actor, rows), await getConfig(db, 'timers.no_show_hours')]
  const out: ArrivalRow[] = []
  for (const r of rows) {
    const b = beds.get(r.bedId)
    if (!b) continue
    const today = localDate(now, b.siteTimeZone)
    const horizonEnd = new Date(Date.parse(today + 'T00:00:00Z') + horizon * 86_400_000).toISOString().slice(0, 10)
    if (r.from > horizonEnd) continue
    const p = personOf(people, r.staffId)
    const view = arrivalView({ nowMs: now.getTime(), etaMs: r.eta.getTime(), noShowHours, extended: r.extended, arrival: r.from, today, bedState: b.state })
    const block = r.from <= today ? readinessBlock({ code: b.code, state: b.state, stateReason: b.stateReason }) : undefined
    out.push({
      reservationId: r.reservationId, staffId: r.staffId, name: p.name, employeeId: p.employeeId, siteId: r.siteId, siteName: b.siteName,
      bedId: r.bedId, bedCode: b.code, bedLabel: b.label, bedState: b.state, from: r.from, to: r.to, eta: r.eta.toISOString(),
      noShowAfter: new Date(noShowDeadlineMs(r.eta.getTime(), noShowHours, r.extended)).toISOString(), noShowExtended: r.extended,
      view, due: r.from <= today, block,
    })
  }
  // Due first, then site by site, then by expected arrival.
  return out.sort((a, b) => Number(b.due) - Number(a.due) || a.siteName.localeCompare(b.siteName) || a.eta.localeCompare(b.eta) || a.name.localeCompare(b.name))
}
