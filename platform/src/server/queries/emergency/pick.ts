/**
 * What the initiate form needs: find a person by employee ID (minimum fields only) and list the beds the initiator may use.
 * Both are limited to the initiator's own sites (emergency_checkin.initiate), so a guessed id or site shows nothing.
 */
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { bed, building, room, site, staffProfile, stay } from '@/server/db/schema'
import { bedClaim } from '@/server/db/schema'
import type { Db } from '@/server/db/client'
import { scopeFilter, type Actor } from '@/server/policy'
import { scopeSql } from '@/server/queries/scope'
import { OCCUPYING_STAY_STATUSES } from '@/domain/enums'

type Reader = Pick<Db, 'select'>

export interface PersonHit { id: string; employeeId: string; fullName: string; department: string | null; employmentStatus: 'active' | 'left'; hasStay: boolean; isSelf: boolean }

/** Exact employee ID (the business key, case-insensitive). The minimum an initiator needs to be sure it is the right person. */
export async function findPerson(db: Reader, actor: Actor, employeeId: string): Promise<PersonHit | undefined> {
  const key = employeeId.trim().toLowerCase()
  if (!key || scopeFilter(actor, 'emergency_checkin.initiate').kind === 'none') return undefined
  const [p] = await db.select({ id: staffProfile.id, employeeId: staffProfile.employeeId, fullName: staffProfile.fullName, department: staffProfile.department, employmentStatus: staffProfile.employmentStatus })
    .from(staffProfile).where(and(sql`lower(btrim(${staffProfile.employeeId})) = ${key}`, isNull(staffProfile.archivedAt))).limit(1)
  if (!p) return undefined
  const [s] = await db.select({ id: stay.id }).from(stay).where(and(eq(stay.staffId, p.id), inArray(stay.status, [...OCCUPYING_STAY_STATUSES]), isNull(stay.archivedAt))).limit(1)
  return { ...p, hasStay: !!s, isSelf: actor.staffId === p.id }
}

export interface BedChoice { id: string; code: string; roomName: string; buildingName: string | null; floor: string | null; siteId: string; siteName: string; genderPolicy: string; nextClaimFrom: string | null }

/** Available beds in the initiator's sites with no live claim covering today. `nextClaimFrom` warns of a reservation that starts later. */
export async function freeBeds(db: Reader, actor: Actor, today: string, o: { siteId?: string; q?: string; limit?: number } = {}): Promise<BedChoice[]> {
  const f = scopeFilter(actor, 'emergency_checkin.initiate')
  if (f.kind === 'none') return []
  const q = (o.q ?? '').trim()
  const rows = await db.select({
    id: bed.id, code: bed.code, roomName: room.name, buildingName: building.name, floor: room.floor, siteId: bed.siteId, siteName: site.name, genderPolicy: room.genderPolicy,
    nextClaimFrom: sql<string | null>`(select min(lower(c.period))::text from bed_claim c where c.bed_id = ${bed.id} and c.released_at is null and lower(c.period) > ${today}::date)`,
  }).from(bed)
    .innerJoin(room, eq(room.id, bed.roomId)).innerJoin(site, eq(site.id, bed.siteId)).leftJoin(building, eq(building.id, room.buildingId))
    .where(and(
      scopeSql(f, { site: bed.siteId }), o.siteId ? eq(bed.siteId, o.siteId) : undefined,
      eq(bed.state, 'available'), isNull(bed.archivedAt),
      sql`not exists (select 1 from ${bedClaim} c where c.bed_id = ${bed.id} and c.released_at is null and c.period @> ${today}::date)`,
      q ? sql`(${bed.code} ilike ${'%' + q.replace(/[%_\\]/g, m => '\\' + m) + '%'} or ${room.name} ilike ${'%' + q.replace(/[%_\\]/g, m => '\\' + m) + '%'})` : undefined,
    ))
    .orderBy(asc(site.name), asc(room.name), asc(bed.code)).limit(Math.min(o.limit ?? 100, 200))
  return rows
}
