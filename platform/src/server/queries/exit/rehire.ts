/**
 * Find a former employee by employee ID for /exits/rehire and show what stands in the way of rehiring them (D-41), before anyone confirms.
 * Same rules as reactivateStaff(), read-only. The staff directory has no site column, so any holder of the action with a usable scope
 * may look (S-8).
 */
import { and, isNull, sql } from 'drizzle-orm'
import { staffProfile } from '@/server/db/schema'
import type { Db } from '@/server/db/client'
import { scopeFilter, type Actor } from '@/server/policy'
import { closeBlockers } from '@/server/commands/exit/rules'
import { caseItems, exitStay, latestCaseFor, loadPerson, OPEN_CASE_STATUSES, resolveItems } from '@/server/commands/exit/shared'

type Reader = Pick<Db, 'select'>

export interface RehirePreview {
  person: { staffId: string; employeeId: string; fullName: string; department: string | null; employmentStatus: 'active' | 'left'; leftEffective: string | null; hasAccount: boolean; accountStatus: string | null; isSelf: boolean }
  caseId: string | null
  canRehire: boolean
  blocked?: { why: string; owner: string; next: string }
  /** Open items of the old case that block it, each with owner and next action. */
  blockers: { label: string; status: string; owner: string; next: string }[]
}

export async function findForRehire(db: Reader, actor: Actor, employeeId: string): Promise<RehirePreview | undefined> {
  const key = employeeId.trim().toLowerCase()
  if (!key || scopeFilter(actor, 'staff_directory.manage').kind === 'none') return undefined
  const [hit] = await db.select({ id: staffProfile.id, department: staffProfile.department }).from(staffProfile)
    .where(and(sql`lower(btrim(${staffProfile.employeeId})) = ${key}`, isNull(staffProfile.archivedAt))).limit(1)
  if (!hit) return undefined
  const p = await loadPerson(db, hit.id)
  if (!p) return undefined
  const old = await latestCaseFor(db, p.staffId)
  const base: RehirePreview = {
    person: { staffId: p.staffId, employeeId: p.employeeId, fullName: p.fullName, department: hit.department, employmentStatus: p.employmentStatus, leftEffective: p.leftEffective, hasAccount: !!p.userId, accountStatus: p.accountStatus, isSelf: actor.staffId === p.staffId },
    caseId: old?.id ?? null, canRehire: true, blockers: [],
  }
  const block = (why: string, owner: string, next: string, extra: Partial<RehirePreview> = {}): RehirePreview => ({ ...base, canRehire: false, blocked: { why, owner, next }, ...extra })
  if (base.person.isSelf) return block('You cannot rehire yourself (D-26)', 'Another administrator', 'Ask a colleague')
  if (p.employmentStatus !== 'left') return block(`${p.fullName} is not marked as Left, so there is nothing to reactivate`, 'Accommodation Admin', 'Nothing to do')
  const stay = await exitStay(db, p.staffId)
  if (stay && stay.status !== 'checked_out' && stay.status !== 'closed') {
    return block(`${p.fullName} still has a stay that has not been checked out (bed ${stay.bedCode}, ${stay.siteName})`, 'Reception', 'Check them out first (Stays & check-in), then rehire')
  }
  if (old && OPEN_CASE_STATUSES.includes(old.status as (typeof OPEN_CASE_STATUSES)[number])) {
    const items = resolveItems(await caseItems(db, old.id), p.staffId)
    const blockers = closeBlockers(items.map(i => ({ id: i.id, label: i.label, kind: i.kind, mandatory: i.mandatory, effective: i.effective, owner: i.effectiveOwnerRole, lostOrDamaged: i.lostOrDamaged })))
    if (blockers.length > 0) {
      return block(`The clearance case of ${p.fullName} is still open`, [...new Set(blockers.map(b => b.owner))].join(', '),
        'Complete the items, or ask a Policy Approver to waive them with a reason and evidence, then rehire', { blockers: blockers.map(b => ({ label: b.label, status: b.status, owner: b.owner, next: b.next })) })
    }
  }
  return base
}
