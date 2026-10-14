import { and, eq, inArray, or, sql, type AnyColumn, type SQL } from 'drizzle-orm'
import type { ScopeFilter } from '@/server/policy'

/**
 * Turns the policy's ScopeFilter into a WHERE fragment, so out-of-scope rows are never fetched.
 * Pass the columns that carry each kind of scope for the table being queried; a scope kind with no column
 * contributes nothing (it can never widen the result). Returns undefined for "no restriction".
 *   const where = and(scopeSql(scopeFilter(actor, 'rooms_beds.view'), { site: bed.siteId }), eq(bed.state, 'available'))
 */
export function scopeSql(f: ScopeFilter, cols: { site?: AnyColumn; owner?: AnyColumn; assignee?: AnyColumn }): SQL | undefined {
  if (f.kind === 'all') return undefined
  if (f.kind === 'none') return sql`false`
  const parts: SQL[] = []
  if (cols.site && f.siteIds.length) parts.push(inArray(cols.site, [...f.siteIds]))
  if (cols.owner && f.ownerStaffId) parts.push(eq(cols.owner, f.ownerStaffId))
  if (cols.assignee && f.assigneeStaffId) parts.push(eq(cols.assignee, f.assigneeStaffId))
  return parts.length ? or(...parts) : sql`false`
}

export { and }
