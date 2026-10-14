/** Request lists, scoped by requests_waitlist.view in SQL (site for staff roles, own for a Resident). Out-of-scope rows are never fetched. */
import { and, count, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm'
import { accommodationRequest, site, staffProfile } from '@/server/db/schema'
import type { Db } from '@/server/db/client'
import { scopeFilter, type Actor } from '@/server/policy'
import { getConfig } from '@/server/config/registry'
import { isUrgent } from '@/domain/approvals'
import type { RequestStatus, StayTypeDb } from '@/domain/enums'
import { scopeSql } from '../scope'
import { OPEN_STATUSES } from '@/server/commands/requests/shared'

type Reader = Pick<Db, 'select'>

export interface RequestListItem {
  id: string
  status: RequestStatus
  urgent: boolean
  staffId: string
  name: string
  employeeId: string
  siteId: string
  siteName: string
  arrivalDate: string
  endDate: string | null
  stayType: StayTypeDb
  onBehalf: boolean
  createdAt: string
  updatedAt: string
}
export interface RequestFilters { status?: RequestStatus | 'open'; siteId?: string; q?: string; limit?: number; offset?: number }
export interface RequestList { items: RequestListItem[]; total: number; limit: number; offset: number }

const like = (q: string) => `%${q.replace(/[\\%_]/g, m => '\\' + m)}%`

export async function listRequests(db: Reader, actor: Actor, f: RequestFilters, now: Date): Promise<RequestList> {
  const limit = Math.min(Math.max(Math.trunc(f.limit ?? 25) || 25, 1), 100)
  const offset = Math.max(Math.trunc(f.offset ?? 0) || 0, 0)
  const q = (f.q ?? '').trim()
  const where = and(
    scopeSql(scopeFilter(actor, 'requests_waitlist.view'), { site: accommodationRequest.siteId, owner: accommodationRequest.staffId }),
    f.status === 'open' ? inArray(accommodationRequest.status, [...OPEN_STATUSES]) : f.status ? eq(accommodationRequest.status, f.status) : undefined,
    f.siteId ? eq(accommodationRequest.siteId, f.siteId) : undefined,
    q ? or(ilike(staffProfile.fullName, like(q)), ilike(staffProfile.employeeId, like(q))) : undefined,
  )
  const base = db.select({
    id: accommodationRequest.id, status: accommodationRequest.status, staffId: accommodationRequest.staffId, name: staffProfile.fullName, employeeId: staffProfile.employeeId,
    siteId: accommodationRequest.siteId, siteName: site.name, arrivalDate: accommodationRequest.arrivalDate, endDate: accommodationRequest.endDate,
    stayType: accommodationRequest.stayType, onBehalf: accommodationRequest.onBehalf, createdAt: accommodationRequest.createdAt, updatedAt: accommodationRequest.updatedAt,
  }).from(accommodationRequest)
    .innerJoin(staffProfile, eq(staffProfile.id, accommodationRequest.staffId))
    .innerJoin(site, eq(site.id, accommodationRequest.siteId))
    .where(where)
  // Urgent (D-46) first among the ones still waiting for the admin, then newest.
  const rows = await base.orderBy(
    sql`(${accommodationRequest.status} = 'submitted') DESC`, sql`CASE WHEN ${accommodationRequest.status} = 'submitted' THEN ${accommodationRequest.arrivalDate} END ASC NULLS LAST`, desc(accommodationRequest.createdAt),
  ).limit(limit).offset(offset)
  const [{ n }] = await db.select({ n: count() }).from(accommodationRequest)
    .innerJoin(staffProfile, eq(staffProfile.id, accommodationRequest.staffId)).where(where)
  const sla = await getConfig(db, 'timers.routine_sla_business_days')
  return {
    total: Number(n), limit, offset,
    items: rows.map(r => ({
      ...r, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
      urgent: r.status === 'submitted' && isUrgent(r.arrivalDate, now.getTime(), sla),
    })),
  }
}
