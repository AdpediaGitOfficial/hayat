import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import { bed, bedClaim, bedOffer, building, reservation, room, site, staffProfile, stay, userAccount } from '@/server/db/schema'
import { bedBlock } from '@/server/db/schema.property'
import { getDb } from '@/server/db/client'
import { can, scopeFilter, type Actor } from '@/server/policy'
import { scopeSql } from '@/server/queries/scope'
import { getClock } from '@/server/runtime'
import { upcomingClaims } from '@/server/commands/property/claims'
import { isUuid, todayInZone } from '@/server/commands/property/shared'
import { getSiteTree } from './tree'
import type { BedDetail, BuildingDetail, RoomDetail } from './types'

/** One bed with its path, block, upcoming claims (read-only from bed_claim) and history. Undefined = not found (404). */
export async function getBedDetail(actor: Actor, bedId: string, now: Date = getClock().now()): Promise<BedDetail | undefined> {
  if (!isUuid(bedId)) return undefined
  const db = getDb()
  const [row] = await db.select({
    bed, room, building, site,
  }).from(bed)
    .innerJoin(room, eq(bed.roomId, room.id))
    .innerJoin(site, eq(bed.siteId, site.id))
    .leftJoin(building, eq(room.buildingId, building.id))
    .where(and(eq(bed.id, bedId), scopeSql(scopeFilter(actor, 'rooms_beds.view'), { site: bed.siteId }), scopeSql(scopeFilter(actor, 'sites_buildings.view'), { site: bed.siteId })))
  if (!row) return undefined

  const today = todayInZone(now, row.site.timeZone)
  const [openBlock] = await db.select({
    reason: bedBlock.reason, until: bedBlock.untilDate, blockedAt: bedBlock.blockedAt, name: staffProfile.fullName,
  }).from(bedBlock)
    .leftJoin(userAccount, eq(userAccount.id, bedBlock.blockedBy))
    .leftJoin(staffProfile, eq(staffProfile.id, userAccount.staffId))
    .where(and(eq(bedBlock.bedId, bedId), isNull(bedBlock.releasedAt)))
  const history = await db.select({ reason: bedBlock.reason, until: bedBlock.untilDate, blockedAt: bedBlock.blockedAt, releasedAt: bedBlock.releasedAt })
    .from(bedBlock).where(eq(bedBlock.bedId, bedId)).orderBy(desc(bedBlock.blockedAt)).limit(10)

  const claims = await upcomingClaims(db, [bedId], today)
  // Who a claim is for is staff data: only actors who may see the staff directory of this site get it.
  const seesStaff = can(actor, 'staff_directory.view', { siteId: row.bed.siteId })
  const holders = new Map<string, { staffId: string; name: string; employeeId: string } | null>()
  if (seesStaff && claims.length) {
    const rows = await db.select({
      claimId: bedClaim.id, staffId: staffProfile.id, name: staffProfile.fullName, employeeId: staffProfile.employeeId,
    }).from(bedClaim)
      .leftJoin(reservation, eq(reservation.claimId, bedClaim.id))
      .leftJoin(stay, eq(stay.claimId, bedClaim.id))
      .leftJoin(bedOffer, eq(bedOffer.claimId, bedClaim.id))
      .leftJoin(staffProfile, eq(staffProfile.id, sql`coalesce(${reservation.staffId}, ${stay.staffId}, ${bedOffer.staffId})`))
      .where(and(eq(bedClaim.bedId, bedId), isNull(bedClaim.releasedAt)))
    for (const r of rows) holders.set(r.claimId, r.staffId ? { staffId: r.staffId, name: r.name!, employeeId: r.employeeId! } : null)
  }

  return {
    id: row.bed.id, code: row.bed.code, state: row.bed.state, stateReason: row.bed.stateReason, stateSince: row.bed.stateSince.toISOString(),
    archived: row.bed.archivedAt !== null,
    site: { id: row.site.id, code: row.site.code, name: row.site.name, timeZone: row.site.timeZone },
    building: row.building ? { id: row.building.id, code: row.building.code, name: row.building.name } : null,
    room: { id: row.room.id, name: row.room.name, floor: row.room.floor, unit: row.room.unit, genderPolicy: row.room.genderPolicy, archived: row.room.archivedAt !== null },
    block: openBlock ? { reason: openBlock.reason, until: openBlock.until ?? null, blockedAt: openBlock.blockedAt.toISOString(), blockedByName: openBlock.name ?? null } : null,
    today,
    claims: claims.map(c => ({
      claimId: c.claimId, kind: c.kind, from: c.from, to: c.to,
      ...(seesStaff ? { holder: holders.get(c.claimId) ?? null } : {}),
    })),
    history: history.map(h => ({ reason: h.reason, until: h.until ?? null, blockedAt: h.blockedAt.toISOString(), releasedAt: h.releasedAt?.toISOString() ?? null })),
  }
}

/** A room with its beds. Undefined = not found (404). */
export async function getRoomDetail(actor: Actor, roomId: string, now: Date = getClock().now()): Promise<RoomDetail | undefined> {
  if (!isUuid(roomId)) return undefined
  const db = getDb()
  const [row] = await db.select({ room, site, building }).from(room)
    .innerJoin(site, eq(room.siteId, site.id))
    .leftJoin(building, eq(room.buildingId, building.id))
    .where(and(eq(room.id, roomId), scopeSql(scopeFilter(actor, 'rooms_beds.view'), { site: room.siteId }), scopeSql(scopeFilter(actor, 'sites_buildings.view'), { site: room.siteId })))
  if (!row) return undefined
  // Reuse the tree: it already knows how to count, order and attach upcoming claims. The scope was checked above and again inside.
  const tree = await getSiteTree(actor, row.site.id, { includeArchived: true }, now)
  const r = tree && [...tree.directRooms, ...tree.buildings.flatMap(b => b.rooms)].find(x => x.id === roomId)
  if (!tree || !r) return undefined
  return {
    id: r.id, name: r.name, floor: r.floor, unit: r.unit, genderPolicy: r.genderPolicy, archived: r.archived,
    site: { id: row.site.id, code: row.site.code, name: row.site.name },
    building: row.building ? { id: row.building.id, code: row.building.code, name: row.building.name } : null,
    beds: r.beds, counts: r.counts,
  }
}

/** A building with its rooms. Undefined = not found (404). */
export async function getBuildingDetail(actor: Actor, buildingId: string, now: Date = getClock().now()): Promise<BuildingDetail | undefined> {
  if (!isUuid(buildingId)) return undefined
  const db = getDb()
  const [row] = await db.select({ building, site }).from(building)
    .innerJoin(site, eq(building.siteId, site.id))
    .where(and(eq(building.id, buildingId), scopeSql(scopeFilter(actor, 'rooms_beds.view'), { site: building.siteId }), scopeSql(scopeFilter(actor, 'sites_buildings.view'), { site: building.siteId })))
  if (!row) return undefined
  const tree = await getSiteTree(actor, row.site.id, { includeArchived: true }, now)
  const b = tree?.buildings.find(x => x.id === buildingId)
  if (!tree || !b) return undefined
  return {
    id: b.id, code: b.code, name: b.name, archived: b.archived,
    site: { id: row.site.id, code: row.site.code, name: row.site.name },
    rooms: b.rooms.map(r => ({ id: r.id, name: r.name, floor: r.floor, unit: r.unit, genderPolicy: r.genderPolicy, counts: r.counts })),
    counts: b.counts,
  }
}
