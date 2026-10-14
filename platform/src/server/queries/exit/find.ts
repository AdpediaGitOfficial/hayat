/**
 * Find a person by employee ID for /exits/new and show what Mark as Left would do, before anyone confirms (nothing is changed).
 * Out of scope reads exactly like "no such person". The same refusals the command applies are shown here as a blocked state
 * with reason, owner and next action, so the form never invites a click that is bound to fail.
 */
import { and, isNull, sql } from 'drizzle-orm'
import { staffProfile } from '@/server/db/schema'
import type { Db } from '@/server/db/client'
import type { Actor } from '@/server/policy'
import { activeSuperAdminIds, isFullSuperAdmin, loadTarget, targetManageableBy } from '@/server/commands/access/guards'
import { authorizeAtSite, exitSiteId, holdsSuperAdmin, latestCaseFor, loadPerson, sitedOnlyFailure, OPEN_CASE_STATUSES } from '@/server/commands/exit/shared'
import { describeImpact, exitImpact, type ExitImpact } from './impact'

type Reader = Pick<Db, 'select'>

export interface ExitPreview {
  person: { staffId: string; employeeId: string; fullName: string; department: string | null; employmentStatus: 'active' | 'left'; leftEffective: string | null; hasAccount: boolean; isSelf: boolean }
  siteId: string | null
  impact: ExitImpact
  /** What will happen, one sentence each. */
  willHappen: string[]
  canMark: boolean
  blocked?: { why: string; owner: string; next: string }
  existingCaseId?: string
}

export async function findForExit(db: Reader, actor: Actor, employeeId: string): Promise<ExitPreview | undefined> {
  const key = employeeId.trim().toLowerCase()
  if (!key) return undefined
  const [hit] = await db.select({ id: staffProfile.id, department: staffProfile.department }).from(staffProfile)
    .where(and(sql`lower(btrim(${staffProfile.employeeId})) = ${key}`, isNull(staffProfile.archivedAt))).limit(1)
  if (!hit) return undefined
  const p = await loadPerson(db, hit.id)
  if (!p) return undefined
  const earlier = p.employmentStatus === 'left' ? await latestCaseFor(db, p.staffId) : undefined
  const siteId = (await exitSiteId(db, p.staffId)) ?? earlier?.siteId ?? undefined
  if (authorizeAtSite({ actor }, 'exit_clearance.mark_left', siteId)) return undefined

  const impact = await exitImpact(db, p.staffId)
  const base: ExitPreview = {
    person: { staffId: p.staffId, employeeId: p.employeeId, fullName: p.fullName, department: hit.department, employmentStatus: p.employmentStatus, leftEffective: p.leftEffective, hasAccount: !!p.userId, isSelf: actor.staffId === p.staffId },
    siteId: siteId ?? null, impact, willHappen: describeImpact(impact), canMark: true,
  }
  const block = (why: string, owner: string, next: string, extra: Partial<ExitPreview> = {}): ExitPreview => ({ ...base, canMark: false, blocked: { why, owner, next }, ...extra })

  if (p.employmentStatus === 'left') {
    return block(`${p.fullName} is already marked as Left${p.leftEffective ? ` (effective ${p.leftEffective})` : ''}`, 'Accommodation Admin',
      earlier && OPEN_CASE_STATUSES.includes(earlier.status as (typeof OPEN_CASE_STATUSES)[number]) ? 'Open their clearance case and work the checklist' : 'Nothing to do. To bring them back, use Rehire on their staff profile', { existingCaseId: earlier?.id })
  }
  if (base.person.isSelf) return block('You cannot mark yourself as Left (D-26)', 'Another Accommodation Admin or a Super Admin', 'Ask a colleague to do it')
  // P-08 (proposed, pending client sign-off; `exit.sited_only`): the same refusal the command gives, shown before anyone clicks
  const unsited = await sitedOnlyFailure({ actor, tx: db }, p.staffId, siteId)
  if (unsited) return block(unsited.reason, unsited.owner ?? 'Super Admin', unsited.next ?? 'Ask a Super Admin to mark them as Left')
  if (p.userId) {
    const t = await loadTarget(db, p.userId)
    if (t && t.adminType && !isFullSuperAdmin(actor) && !targetManageableBy(actor, t)) {
      return block(`${p.fullName} holds an administrator role`, 'Super Admin', 'Ask a Super Admin to mark them as Left')
    }
    const sas = (await holdsSuperAdmin(db, p.userId)) ? await activeSuperAdminIds(db) : []
    if (sas.includes(p.userId) && !sas.some(id => id !== p.userId)) {
      return block(`${p.fullName} is the last active Super Admin and can never be removed (D-27)`, 'Super Admin', 'Appoint and activate another Super Admin first')
    }
  }
  const open = await latestCaseFor(db, p.staffId)
  if (open && OPEN_CASE_STATUSES.includes(open.status as (typeof OPEN_CASE_STATUSES)[number])) {
    return block(`${p.fullName} still has an open clearance case from an earlier exit`, 'Accommodation Admin', 'Close the earlier case first', { existingCaseId: open.id })
  }
  return base
}
