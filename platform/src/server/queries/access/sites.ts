import { and, asc, eq, isNull } from 'drizzle-orm'
import { getDb } from '@/server/db/client'
import { building, site } from '@/server/db/schema'
import { scopeFilter, type Action, type Actor } from '@/server/policy'
import { scopeSql } from '@/server/queries/scope'

export interface SiteOption { id: string; code: string; name: string }

/** Active sites the actor may use in a form for `action` (all sites for a global actor; their own sites otherwise). */
export async function selectableSites(actor: Actor, action: Action): Promise<SiteOption[]> {
  const where = and(isNull(site.archivedAt), scopeSql(scopeFilter(actor, action), { site: site.id }))
  return getDb().select({ id: site.id, code: site.code, name: site.name }).from(site).where(where).orderBy(asc(site.code))
}

export interface BuildingOption { id: string; label: string }

/** Active buildings for the role form (a building scope is allowed but gives no site scope yet, S-6). */
export async function selectableBuildings(actor: Actor, action: Action): Promise<BuildingOption[]> {
  const rows = await getDb().select({ id: building.id, name: building.name, siteCode: site.code }).from(building)
    .innerJoin(site, eq(site.id, building.siteId))
    .where(and(isNull(building.archivedAt), isNull(site.archivedAt), scopeSql(scopeFilter(actor, action), { site: building.siteId })))
    .orderBy(asc(site.code), asc(building.code))
  return rows.map(r => ({ id: r.id, label: `${r.siteCode} / ${r.name}` }))
}
