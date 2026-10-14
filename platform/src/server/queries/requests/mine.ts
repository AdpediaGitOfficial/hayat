/** "My accommodation": the person's own current request and reservation. Always the actor's own staff record, whatever mode they are in. */
import { and, desc, eq, inArray } from 'drizzle-orm'
import { accommodationRequest, bed, bedClaim, reservation, room, site } from '@/server/db/schema'
import type { Db } from '@/server/db/client'
import { getConfig } from '@/server/config/registry'
import { HOUR } from '@/domain/time'
import type { RequestStatus, ReservationStatus, StayTypeDb } from '@/domain/enums'

type Reader = Pick<Db, 'select'>

export interface MyRequest {
  id: string; status: RequestStatus; siteName: string; arrivalDate: string; endDate: string | null; stayType: StayTypeDb; note: string | null
  decisionReason: string | null; createdAt: string; canEdit: boolean; canCancel: boolean
}
export interface MyReservation {
  id: string; status: ReservationStatus; bedLabel: string; from: string; to: string | null; noShowDeadline: string
}

export async function myAccommodation(db: Reader, staffId: string, now: Date): Promise<{ request: MyRequest | null; reservation: MyReservation | null }> {
  // The open request if there is one, else the most recent decided one (so a rejection or cancellation is still explained).
  const rows = await db.select({ r: accommodationRequest, siteName: site.name }).from(accommodationRequest).innerJoin(site, eq(site.id, accommodationRequest.siteId))
    .where(eq(accommodationRequest.staffId, staffId)).orderBy(desc(accommodationRequest.createdAt)).limit(5)
  const open = rows.find(x => ['submitted', 'pending_approval', 'changes_requested'].includes(x.r.status))
  const latest = rows[0] // newest first: an older rejection is history once a newer request exists
  const pick = open ?? (latest && ['rejected', 'cancelled', 'waitlisted'].includes(latest.r.status) && now.getTime() - latest.r.updatedAt.getTime() < 14 * 86_400_000 ? latest : undefined)
  const request: MyRequest | null = pick ? {
    id: pick.r.id, status: pick.r.status, siteName: pick.siteName, arrivalDate: pick.r.arrivalDate, endDate: pick.r.endDate, stayType: pick.r.stayType, note: pick.r.note,
    decisionReason: pick.r.decisionReason, createdAt: pick.r.createdAt.toISOString(),
    canEdit: pick.r.status === 'changes_requested', canCancel: ['submitted', 'pending_approval', 'changes_requested'].includes(pick.r.status),
  } : null

  const [rv] = await db.select({
    id: reservation.id, status: reservation.status, eta: reservation.eta, extended: reservation.noShowExtended, code: bed.code, roomName: room.name, siteName: site.name,
    period: bedClaim.period,
  }).from(reservation).innerJoin(bed, eq(bed.id, reservation.bedId)).innerJoin(room, eq(room.id, bed.roomId)).innerJoin(site, eq(site.id, bed.siteId))
    .innerJoin(bedClaim, eq(bedClaim.id, reservation.claimId))
    .where(and(eq(reservation.staffId, staffId), inArray(reservation.status, ['reserved']))).orderBy(desc(reservation.createdAt)).limit(1)
  let res: MyReservation | null = null
  if (rv) {
    const m = /^[\[(]([^,]*),([^)\]]*)[)\]]$/.exec(rv.period)
    const hours = await getConfig(db, 'timers.no_show_hours')
    res = {
      id: rv.id, status: rv.status, bedLabel: `Bed ${rv.code}, Room ${rv.roomName}, ${rv.siteName}`, from: m?.[1] ?? '', to: m?.[2] ? m[2] : null,
      noShowDeadline: new Date(rv.eta.getTime() + hours * HOUR * (rv.extended ? 2 : 1)).toISOString(),
    }
  }
  return { request, reservation: res }
}
