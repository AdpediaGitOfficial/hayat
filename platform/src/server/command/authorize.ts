import type { Failure } from './result'
import { fail } from './result'
import type { RequestContext } from './context'
import { decide, type Action, type Resource } from '@/server/policy'

/**
 * Authorization inside a command or query, after the route-level "may this role ever do this" guard.
 * Out of scope reads like a record that does not exist (404, AT-001/002); lacking the action is 403.
 * Returns the failure to hand back, or undefined when allowed:
 *   const denied = authorize(c, 'rooms_beds.manage', { siteId }); if (denied) return denied
 */
export function authorize(c: Pick<RequestContext, 'actor'>, action: Action, resource?: Resource): Failure | undefined {
  const d = decide(c.actor, action, resource)
  if (d.allowed) return undefined
  return d.reason === 'out_of_scope' ? fail.notFound() : fail.forbidden(`do this (${action})`)
}

/**
 * Separation of duties (D-26): nobody acts on their own record. `subjectStaffId` is the staff member the record is about.
 * Returns the failure, or undefined when the actor is someone else.
 */
export function notSelf(c: Pick<RequestContext, 'actor'>, subjectStaffId: string | null | undefined, what: string): Failure | undefined {
  if (subjectStaffId && c.actor.staffId === subjectStaffId) return fail.sod(`You cannot ${what} on your own record`)
  return undefined
}
