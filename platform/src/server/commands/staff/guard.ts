import { authorize } from '@/server/command/authorize'
import { fail, type Failure } from '@/server/command/result'
import type { CommandContext } from '@/server/command/context'
import { scopeFilter, type Action } from '@/server/policy'

/**
 * Write access to the staff directory. Roles and capability grants add the action; scope still has to exist, so an
 * admin with no site assigned (scopeFilter 'none') cannot write either. The directory has no site column, so any
 * assigned site is enough (S-8, open question). Returns the failure to hand back, or undefined when allowed.
 */
export function requireDirectory(c: Pick<CommandContext, 'actor'>, action: Extract<Action, 'staff_directory.manage' | 'staff_directory.import_csv'>): Failure | undefined {
  const denied = authorize(c, action)
  if (denied) return denied
  if (scopeFilter(c.actor, action).kind === 'none') {
    return fail.forbidden('change the staff directory because no site is assigned to you', 'Super Admin')
  }
  return undefined
}

/** A path parameter that is not a UUID can never name a record: answer "not found" instead of letting the database complain. */
export const isUuid = (s: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)
