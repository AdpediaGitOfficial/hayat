/**
 * Who sees which part of a staff record (AT-001, PERMISSIONS.md "minimum data").
 *
 * The staff_directory module has four read actions, from most to least revealing:
 *   view            SA, AA, Auditor, StaffMaster holders -> the full profile
 *   lookup_minimum  Reception                            -> name, employee ID, department, employment status
 *   identity_check  Security                             -> name, employee ID, employment status
 *   view_own        Resident                             -> their own record only
 * An actor gets the shape of the strongest read action they hold with a usable scope. The shape is chosen BEFORE the query
 * runs and the query selects only that shape's columns, so a masked field is never fetched, let alone returned.
 *
 * Site scope (S-8, open question): staff_profile has no site column, so a site-scoped grant on these actions is treated as
 * organisation-wide for the directory. An actor with the action but no site assigned at all gets nothing (scopeFilter 'none').
 */
import { eq, sql, type SQL } from 'drizzle-orm'
import { scopeFilter, type Action, type Actor, type ScopeFilter } from '@/server/policy'
import { staffProfile } from '@/server/db/schema'

export type StaffShape = 'full' | 'own' | 'minimum' | 'identity'

export const STAFF_READ_ACTIONS: readonly { action: Action; shape: StaffShape }[] = [
  { action: 'staff_directory.view', shape: 'full' },
  { action: 'staff_directory.lookup_minimum', shape: 'minimum' },
  { action: 'staff_directory.identity_check', shape: 'identity' },
  { action: 'staff_directory.view_own', shape: 'own' },
]

export interface StaffAccess {
  shape: StaffShape
  action: Action
  /** WHERE fragment restricting the rows; undefined = every row. */
  where: SQL | undefined
  /** True when the actor may only ever see their own record. */
  ownOnly: boolean
  /** Lookup roles find a person by searching; they cannot browse the whole directory. */
  searchRequired: boolean
  /** Archived profiles are visible only to the full shape. */
  mayIncludeArchived: boolean
}

function rowFilter(f: ScopeFilter): { where: SQL | undefined; ownOnly: boolean } | null {
  if (f.kind === 'none') return null
  if (f.kind === 'all') return { where: undefined, ownOnly: false }
  if (f.siteIds.length > 0) return { where: undefined, ownOnly: false } // site scope = organisation-wide for the directory (S-8)
  if (f.ownerStaffId) return { where: eq(staffProfile.id, f.ownerStaffId), ownOnly: true }
  return null
}

/** The actor's read access to the directory, or null when they hold none. */
export function staffAccess(actor: Actor): StaffAccess | null {
  for (const { action, shape } of STAFF_READ_ACTIONS) {
    const rf = rowFilter(scopeFilter(actor, action))
    if (!rf) continue
    return {
      shape, action, where: rf.where, ownOnly: rf.ownOnly,
      searchRequired: shape === 'minimum' || shape === 'identity',
      mayIncludeArchived: shape === 'full',
    }
  }
  return null
}

/** Escapes LIKE wildcards so a search for "50%" or "a_b" matches literally. */
export const likePattern = (q: string) => `%${q.replace(/[\\%_]/g, m => '\\' + m)}%`

/** lower(btrim(employee_id)): the business key (D-05). The same expression the unique index uses. */
export const employeeKey = sql`lower(btrim(${staffProfile.employeeId}))`
