import { and, asc, count, eq, ilike, isNull, or, sql, type SQL } from 'drizzle-orm'
import { bed, bedClaim, building, room, site } from '@/server/db/schema'
import { bedBlock } from '@/server/db/schema.property'
import { getDb } from '@/server/db/client'
import { scopeFilter, type Actor } from '@/server/policy'
import { scopeSql } from '@/server/queries/scope'
import { getClock } from '@/server/runtime'
import { upcomingClaims } from '@/server/commands/property/claims'
import { isUuid, todayInZone } from '@/server/commands/property/shared'
import { BED_STATES } from '@/domain/enums'
import { emptyCounts, type SiteTree, type StateCounts, type TreeBed, type TreeBuilding, type TreeFilter, type TreeRoom } from './types'

const natural = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })

/** Cleans a user-typed filter: unknown states are ignored, the search text is length-limited. */
export function normalizeFilter(f: TreeFilter): TreeFilter {
  const out: TreeFilter = {}
  if (f.state && (BED_STATES as readonly string[]).includes(f.state)) out.state = f.state
  if (f.reserved) out.reserved = true
  const q = f.q?.trim().slice(0, 60)
  if (q) out.q = q
  if (f.includeArchived) out.includeArchived = true
  return out
}

const likePattern = (q: string) => `%${q.replace(/[\\%_]/g, '\\$&')}%`

/** The site's full building -> room -> bed tree, scoped to what the actor may see. Undefined = not found (404). */
export async function getSiteTree(actor: Actor, siteId: string, filterIn: TreeFilter = {}, now: Date = getClock().now()): Promise<SiteTree | undefined> {
  if (!isUuid(siteId)) return undefined
  const db = getDb()
  const filter = normalizeFilter(filterIn)
  const [s] = await db.select().from(site).where(and(
    eq(site.id, siteId),
    scopeSql(scopeFilter(actor, 'sites_buildings.view'), { site: site.id }),
    scopeSql(scopeFilter(actor, 'rooms_beds.view'), { site: site.id }),
  ))
  if (!s) return undefined
  const today = todayInZone(now, s.timeZone)
  const showArchived = !!filter.includeArchived || filter.state === 'archived'

  /* ---- beds that match the filter ---- */
  const conds: (SQL | undefined)[] = [eq(bed.siteId, s.id)]
  if (!showArchived) conds.push(isNull(bed.archivedAt))
  if (filter.state) conds.push(eq(bed.state, filter.state))
  if (filter.reserved) {
    conds.push(sql`exists (select 1 from bed_claim bc where bc.bed_id = ${bed.id} and bc.released_at is null and (upper_inf(bc.period) or upper(bc.period) > ${today}::date))`)
  }
  if (filter.q) {
    const p = likePattern(filter.q)
    conds.push(or(ilike(bed.code, p), ilike(room.name, p), ilike(building.name, p), ilike(building.code, p)))
  }
  const bedRows = await db.select({
    id: bed.id, roomId: bed.roomId, code: bed.code, state: bed.state, stateReason: bed.stateReason, stateSince: bed.stateSince,
    archivedAt: bed.archivedAt, blockedUntil: bedBlock.untilDate,
  }).from(bed)
    .innerJoin(room, eq(bed.roomId, room.id))
    .leftJoin(building, eq(room.buildingId, building.id))
    .leftJoin(bedBlock, and(eq(bedBlock.bedId, bed.id), isNull(bedBlock.releasedAt)))
    .where(and(...conds))
    .orderBy(asc(bed.code))

  const claims = await upcomingClaims(db, bedRows.map(b => b.id), today)
  const claimsBy = new Map<string, typeof claims>()
  for (const c of claims) claimsBy.set(c.bedId, [...(claimsBy.get(c.bedId) ?? []), c])

  /* ---- structure and roll-up counts (ignoring the filter, so the chips stay stable) ---- */
  const [roomRows, buildingRows, countRows, reservedRows] = await Promise.all([
    db.select().from(room).where(and(eq(room.siteId, s.id), showArchived ? undefined : isNull(room.archivedAt))),
    db.select().from(building).where(and(eq(building.siteId, s.id), showArchived ? undefined : isNull(building.archivedAt))).orderBy(asc(building.name)),
    db.select({ roomId: bed.roomId, state: bed.state, n: count() }).from(bed).where(and(eq(bed.siteId, s.id), isNull(bed.archivedAt))).groupBy(bed.roomId, bed.state),
    db.select({ n: sql<number>`count(distinct ${bed.id})::int` }).from(bed).innerJoin(bedClaim, eq(bedClaim.bedId, bed.id))
      .where(and(eq(bed.siteId, s.id), eq(bed.state, 'available'), isNull(bedClaim.releasedAt), sql`(upper_inf(${bedClaim.period}) OR upper(${bedClaim.period}) > ${today}::date)`)),
  ])
  const roomCounts = new Map<string, StateCounts>()
  const siteCounts = emptyCounts()
  for (const r of countRows) {
    if (r.state === 'archived') continue
    const c = roomCounts.get(r.roomId) ?? emptyCounts()
    c[r.state] += r.n; c.total += r.n
    siteCounts[r.state] += r.n; siteCounts.total += r.n
    roomCounts.set(r.roomId, c)
  }

  const treeBeds = new Map<string, TreeBed[]>()
  for (const b of bedRows) {
    const list = claimsBy.get(b.id) ?? []
    const first = list[0]
    const tb: TreeBed = {
      id: b.id, code: b.code, state: b.state, stateReason: b.stateReason, stateSince: b.stateSince.toISOString(),
      blockedUntil: b.blockedUntil ?? null, archived: b.archivedAt !== null,
      upcomingCount: list.length,
      nextClaim: first ? { claimId: first.claimId, kind: first.kind, from: first.from, to: first.to } : null,
    }
    treeBeds.set(b.roomId, [...(treeBeds.get(b.roomId) ?? []), tb])
  }

  const filtering = !!(filter.state || filter.reserved || filter.q)
  const toRoom = (r: typeof roomRows[number]): TreeRoom => ({
    id: r.id, name: r.name, floor: r.floor, unit: r.unit, genderPolicy: r.genderPolicy, buildingId: r.buildingId,
    archived: r.archivedAt !== null, beds: (treeBeds.get(r.id) ?? []).sort((a, b) => natural.compare(a.code, b.code)),
    counts: roomCounts.get(r.id) ?? emptyCounts(),
  })
  const rooms = roomRows.map(toRoom)
    .filter(r => !filtering || r.beds.length > 0)
    .sort((a, b) => natural.compare(a.floor ?? '', b.floor ?? '') || natural.compare(a.unit ?? '', b.unit ?? '') || natural.compare(a.name, b.name))

  const buildings: TreeBuilding[] = buildingRows.map(b => {
    const rs = rooms.filter(r => r.buildingId === b.id)
    const counts = emptyCounts()
    for (const r of rs) for (const k of Object.keys(counts) as (keyof StateCounts)[]) counts[k] += r.counts[k]
    return { id: b.id, code: b.code, name: b.name, archived: b.archivedAt !== null, rooms: rs, counts }
  }).filter(b => !filtering || b.rooms.length > 0)

  return {
    site: { id: s.id, code: s.code, name: s.name, kind: s.kind, timeZone: s.timeZone, archived: s.archivedAt !== null, beds: siteCounts, rooms: roomRows.length, buildings: buildingRows.length },
    buildings,
    directRooms: rooms.filter(r => r.buildingId === null),
    counts: siteCounts,
    availableReserved: reservedRows[0]?.n ?? 0,
    today,
    filter,
  }
}
