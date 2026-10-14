/** Reservation list and detail, scoped by reservations_stays.view (site for staff, own for a Resident), in SQL. */
import { and, count, desc, eq, ilike, or, sql } from 'drizzle-orm'
import { bed, bedClaim, reservation, room, site, staffProfile } from '@/server/db/schema'
import type { Db } from '@/server/db/client'
import { can, scopeFilter, type Actor } from '@/server/policy'
import { getConfig } from '@/server/config/registry'
import { HOUR } from '@/domain/time'
import type { ReservationStatus } from '@/domain/enums'
import { scopeSql } from '../scope'

type Reader = Pick<Db, 'select'>

export interface ReservationView {
  id: string
  status: ReservationStatus
  staffId: string
  name: string
  employeeId: string
  siteId: string
  siteName: string
  bedId: string
  bedCode: string
  roomName: string
  /** Arrival day and departure day (end-exclusive, D-103); null = open-ended. */
  from: string
  to: string | null
  eta: string
  noShowExtended: boolean
  /** When the no-show clock runs out: eta + timers.no_show_hours, doubled once if extended (D-58). */
  noShowDeadline: string
  source: string
  requestId: string | null
  cancelReason: string | null
  can: { cancel: boolean; extend: boolean }
}
export interface ReservationFilters { status?: ReservationStatus; siteId?: string; q?: string; limit?: number; offset?: number }

const like = (q: string) => `%${q.replace(/[\\%_]/g, m => '\\' + m)}%`
const SELECT = {
  id: reservation.id, status: reservation.status, staffId: reservation.staffId, name: staffProfile.fullName, employeeId: staffProfile.employeeId,
  siteId: bed.siteId, siteName: site.name, bedId: bed.id, bedCode: bed.code, roomName: room.name, eta: reservation.eta, noShowExtended: reservation.noShowExtended,
  source: reservation.source, requestId: reservation.requestId, cancelReason: reservation.cancelReason,
  from: sql<string>`lower(${bedClaim.period})::text`, to: sql<string | null>`upper(${bedClaim.period})::text`,
}

function shape(rows: { id: string; status: ReservationStatus; staffId: string; name: string; employeeId: string; siteId: string; siteName: string; bedId: string; bedCode: string; roomName: string; eta: Date; noShowExtended: boolean; source: string; requestId: string | null; cancelReason: string | null; from: string; to: string | null }[],
  actor: Actor, hours: number, extensionsAllowed: number): ReservationView[] {
  return rows.map(r => ({
    ...r, eta: r.eta.toISOString(), to: r.to && r.to !== 'infinity' ? r.to : null,
    noShowDeadline: new Date(r.eta.getTime() + hours * HOUR * (r.noShowExtended ? 2 : 1)).toISOString(),
    can: {
      cancel: r.status === 'reserved' && can(actor, 'reservations_stays.manage', { siteId: r.siteId }) && actor.staffId !== r.staffId,
      extend: r.status === 'reserved' && !r.noShowExtended && extensionsAllowed >= 1 && can(actor, 'reservations_stays.manage', { siteId: r.siteId }) && actor.staffId !== r.staffId,
    },
  }))
}

export async function listReservations(db: Reader, actor: Actor, f: ReservationFilters): Promise<{ items: ReservationView[]; total: number; limit: number; offset: number }> {
  const limit = Math.min(Math.max(Math.trunc(f.limit ?? 25) || 25, 1), 100)
  const offset = Math.max(Math.trunc(f.offset ?? 0) || 0, 0)
  const q = (f.q ?? '').trim()
  const where = and(
    scopeSql(scopeFilter(actor, 'reservations_stays.view'), { site: bed.siteId, owner: reservation.staffId }),
    f.status ? eq(reservation.status, f.status) : undefined,
    f.siteId ? eq(bed.siteId, f.siteId) : undefined,
    q ? or(ilike(staffProfile.fullName, like(q)), ilike(staffProfile.employeeId, like(q))) : undefined,
  )
  const rows = await db.select(SELECT).from(reservation)
    .innerJoin(bed, eq(bed.id, reservation.bedId)).innerJoin(room, eq(room.id, bed.roomId)).innerJoin(site, eq(site.id, bed.siteId))
    .innerJoin(staffProfile, eq(staffProfile.id, reservation.staffId)).innerJoin(bedClaim, eq(bedClaim.id, reservation.claimId))
    .where(where).orderBy(sql`(${reservation.status} = 'reserved') DESC`, sql`lower(${bedClaim.period}) ASC`, desc(reservation.createdAt)).limit(limit).offset(offset)
  const [{ n }] = await db.select({ n: count() }).from(reservation).innerJoin(bed, eq(bed.id, reservation.bedId)).innerJoin(staffProfile, eq(staffProfile.id, reservation.staffId)).where(where)
  const hours = await getConfig(db, 'timers.no_show_hours')
  const allowed = await getConfig(db, 'timers.no_show_extensions')
  return { items: shape(rows, actor, hours, allowed), total: Number(n), limit, offset }
}

export async function getReservation(db: Reader, actor: Actor, id: string): Promise<ReservationView | undefined> {
  const where = and(eq(reservation.id, id), scopeSql(scopeFilter(actor, 'reservations_stays.view'), { site: bed.siteId, owner: reservation.staffId }))
  const rows = await db.select(SELECT).from(reservation)
    .innerJoin(bed, eq(bed.id, reservation.bedId)).innerJoin(room, eq(room.id, bed.roomId)).innerJoin(site, eq(site.id, bed.siteId))
    .innerJoin(staffProfile, eq(staffProfile.id, reservation.staffId)).innerJoin(bedClaim, eq(bedClaim.id, reservation.claimId)).where(where).limit(1)
  if (rows.length === 0) return undefined
  return shape(rows, actor, await getConfig(db, 'timers.no_show_hours'), await getConfig(db, 'timers.no_show_extensions'))[0]
}
