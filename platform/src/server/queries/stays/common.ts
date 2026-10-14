/** Shared read helpers for the stay queries (WP-F). Reads only; scope is applied by each query with scopeSql(scopeFilter(...)). */
import { eq, inArray } from 'drizzle-orm'
import { bed, building, room, site, staffProfile } from '@/server/db/schema'
import { getDb } from '@/server/db/client'
import { can, type Actor } from '@/server/policy'

export interface BedInfo {
  id: string
  code: string
  state: string
  stateReason: string | null
  siteId: string
  siteName: string
  siteTimeZone: string
  buildingName: string | null
  roomName: string
  /** "Palm Villas › Block A › Room 12 › Bed A" */
  label: string
}

export async function bedInfoMap(bedIds: string[]): Promise<Map<string, BedInfo>> {
  const ids = [...new Set(bedIds)]
  const out = new Map<string, BedInfo>()
  if (ids.length === 0) return out
  const rows = await getDb().select({
    id: bed.id, code: bed.code, state: bed.state, stateReason: bed.stateReason, siteId: bed.siteId, siteName: site.name, tz: site.timeZone,
    buildingName: building.name, roomName: room.name,
  }).from(bed).innerJoin(room, eq(room.id, bed.roomId)).innerJoin(site, eq(site.id, bed.siteId)).leftJoin(building, eq(building.id, room.buildingId))
    .where(inArray(bed.id, ids))
  for (const r of rows) {
    out.set(r.id, { ...r, siteTimeZone: r.tz, label: [r.siteName, r.buildingName, r.roomName, `Bed ${r.code}`].filter(Boolean).join(' › ') })
  }
  return out
}

export interface PersonInfo { id: string; name: string; employeeId: string }

/**
 * Names are staff data: shown to those who may look staff up at the site (Reception's minimum lookup counts) or when it is the
 * viewer's own record. Everyone else (for example a Read-only Manager) gets a neutral label.
 */
export async function personMap(actor: Actor, rows: { staffId: string; siteId: string }[]): Promise<Map<string, PersonInfo>> {
  const out = new Map<string, PersonInfo>()
  const visible = rows.filter(r =>
    actor.staffId === r.staffId || can(actor, 'staff_directory.view', { siteId: r.siteId }) || can(actor, 'staff_directory.lookup_minimum', { siteId: r.siteId }))
  const ids = [...new Set(visible.map(r => r.staffId))]
  if (ids.length === 0) return out
  const people = await getDb().select({ id: staffProfile.id, name: staffProfile.fullName, employeeId: staffProfile.employeeId }).from(staffProfile).where(inArray(staffProfile.id, ids))
  for (const p of people) out.set(p.id, p)
  return out
}
export const personOf = (m: Map<string, PersonInfo>, staffId: string): PersonInfo => m.get(staffId) ?? { id: staffId, name: 'Resident', employeeId: '' }

/** 'YYYY-MM-DD' in the site's time zone. */
export function localDate(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}
