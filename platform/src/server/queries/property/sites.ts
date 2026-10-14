import { and, asc, count, inArray, isNull } from 'drizzle-orm'
import { bed, building, room, site } from '@/server/db/schema'
import { getDb } from '@/server/db/client'
import { scopeFilter, type Actor } from '@/server/policy'
import { scopeSql } from '@/server/queries/scope'
import { emptyCounts, type SiteSummary, type StateCounts } from './types'

/**
 * Sites the actor may see (sites_buildings.view, scoped in SQL). Bed counts are added only for actors who may also see
 * rooms and beds (rooms_beds.view): Security sees that a site exists, not what is in it.
 */
export async function listSites(actor: Actor, opts: { includeArchived?: boolean } = {}): Promise<SiteSummary[]> {
  const db = getDb()
  const rows = await db.select().from(site)
    .where(and(scopeSql(scopeFilter(actor, 'sites_buildings.view'), { site: site.id }), opts.includeArchived ? undefined : isNull(site.archivedAt)))
    .orderBy(asc(site.name))
  const summaries: SiteSummary[] = rows.map(s => ({ id: s.id, code: s.code, name: s.name, kind: s.kind, timeZone: s.timeZone, archived: s.archivedAt !== null }))
  if (rows.length === 0) return summaries

  const bedScope = scopeFilter(actor, 'rooms_beds.view')
  if (bedScope.kind === 'none') return summaries
  const ids = rows.map(r => r.id)

  const [bedRows, roomRows, buildingRows] = await Promise.all([
    db.select({ siteId: bed.siteId, state: bed.state, n: count() }).from(bed)
      .where(and(inArray(bed.siteId, ids), isNull(bed.archivedAt), scopeSql(bedScope, { site: bed.siteId })))
      .groupBy(bed.siteId, bed.state),
    db.select({ siteId: room.siteId, n: count() }).from(room)
      .where(and(inArray(room.siteId, ids), isNull(room.archivedAt), scopeSql(bedScope, { site: room.siteId }))).groupBy(room.siteId),
    db.select({ siteId: building.siteId, n: count() }).from(building)
      .where(and(inArray(building.siteId, ids), isNull(building.archivedAt), scopeSql(bedScope, { site: building.siteId }))).groupBy(building.siteId),
  ])
  const counts = new Map<string, StateCounts>()
  for (const r of bedRows) {
    const c = counts.get(r.siteId) ?? emptyCounts()
    if (r.state !== 'archived') { c[r.state] += r.n; c.total += r.n }
    counts.set(r.siteId, c)
  }
  const roomsBy = new Map(roomRows.map(r => [r.siteId, r.n]))
  const buildingsBy = new Map(buildingRows.map(r => [r.siteId, r.n]))
  for (const s of summaries) {
    s.beds = counts.get(s.id) ?? emptyCounts()
    s.rooms = roomsBy.get(s.id) ?? 0
    s.buildings = buildingsBy.get(s.id) ?? 0
  }
  return summaries
}
