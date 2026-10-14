/**
 * Rehire (D-41, AT-032): a former employee returns. The EXISTING profile is reactivated (same employee ID): a second profile is never
 * created, and the unique index on the employee ID would refuse it anyway.
 *
 * Blocked, with reason + owner + next action:
 *   - while the person still has a live stay that was not checked out (they are still in the bed),
 *   - while an old clearance case is open, unless every mandatory item is Done, or Waived by the Policy Approver.
 * The login account stays revoked by default. With `reactivateAccount: true` WP-C's reactivateAccount runs afterwards in its OWN
 * transaction (it issues a new temporary password, shown once); if that second step fails the profile stays reactivated and the answer
 * says so plainly, so nobody believes the person can sign in when they cannot.
 */
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { staffProfile } from '@/server/db/schema'
import { audit } from '@/server/audit'
import { notSelf } from '@/server/command/authorize'
import { runCommand } from '@/server/command/run'
import type { RequestContext } from '@/server/command/context'
import { fail, failure, ok, type Result } from '@/server/command/result'
import { confirmPassword } from '@/server/auth/reauth'
import { notify } from '@/server/notify'
import { reactivateAccount } from '@/server/commands/access/reactivate-account'
import { requireDirectory } from '@/server/commands/staff/guard'
import { closeBlockers } from './rules'
import { caseItems, ensureHandoverItems, exitStay, idSchema, latestCaseFor, loadPerson, OPEN_CASE_STATUSES, reasonSchema, resolveItems } from './shared'

export const rehireInput = z.object({
  staffId: idSchema,
  reason: reasonSchema,
  confirmPassword: z.string().max(200).optional(),
  /** Also let the person sign in again (a new temporary password is issued and shown once). */
  reactivateAccount: z.boolean().optional(),
})
export type RehireInput = z.infer<typeof rehireInput>

export interface RehireOut {
  staffId: string
  employeeId: string
  fullName: string
  employmentStatus: 'active'
  previousLeftEffective: string | null
  /** An earlier clearance case that was still open but fully resolved; it is kept, and must be closed before another exit. */
  openCaseId: string | null
  account: 'none' | 'still_disabled' | 'reactivated' | 'not_requested'
  /** The new temporary password, shown once, only when the account was reactivated. */
  temporaryPassword?: string
  username?: string
  /** Why the account step did not happen (partial result). */
  accountProblem?: { reason: string; owner?: string; next?: string }
}

export async function reactivateStaff(rc: RequestContext, i: RehireInput): Promise<Result<RehireOut>> {
  let accountUserId: string | null = null
  const first = await runCommand(rc, async c => {
    const denied = requireDirectory(c, 'staff_directory.manage')
    if (denied) return denied
    const p = await loadPerson(c.tx, i.staffId, true)
    if (!p) return fail.notFound()
    const self = notSelf(c, p.staffId, 'rehire')
    if (self) return self
    if (p.archivedAt) return failure('conflict', `${p.fullName}'s profile is archived`, { owner: 'Super Admin', next: 'Ask a Super Admin whether the archived profile should be reinstated; never create a second one' })
    if (p.employmentStatus !== 'left') return failure('conflict', `${p.fullName} is not marked as Left, so there is nothing to reactivate`, { owner: 'Accommodation Admin', next: 'Nothing to do' })
    const bad = await confirmPassword(c, i.confirmPassword)
    if (bad) return bad
    accountUserId = p.userId

    // Still in the bed: the exit has not finished physically. Checkout is Reception's.
    const stay = await exitStay(c.tx, p.staffId)
    if (stay && stay.status !== 'checked_out' && stay.status !== 'closed') {
      return failure('conflict', `${p.fullName} still has a stay that has not been checked out (bed ${stay.bedCode}, ${stay.siteName})`, {
        owner: 'Reception', next: 'Check them out first (Stays & check-in), then rehire', detail: { reason: 'live_stay', stayId: stay.id },
      })
    }
    // An old clearance case that is still open must have every mandatory item Done, or Waived by the Policy Approver (D-41).
    const old = await latestCaseFor(c.tx, p.staffId)
    let openCaseId: string | null = null
    if (old && OPEN_CASE_STATUSES.includes(old.status as (typeof OPEN_CASE_STATUSES)[number])) {
      await ensureHandoverItems(c.tx, old, c.user.id, c.now) // a key held since the case opened counts too (rolled back if rehire is refused)
      const items = resolveItems(await caseItems(c.tx, old.id), p.staffId)
      const blockers = closeBlockers(items)
      if (blockers.length > 0) {
        return failure('conflict', `The clearance case of ${p.fullName} is still open: ${blockers.map(b => b.label).join('; ')}`, {
          owner: [...new Set(blockers.map(b => b.owner))].join(', '),
          next: 'Complete the items, or ask a Policy Approver to waive them with a reason and evidence, then rehire',
          detail: { reason: 'open_clearance', caseId: old.id, blockers },
        })
      }
      openCaseId = old.id
    }

    const before = { employmentStatus: p.employmentStatus, leftAt: p.leftAt?.toISOString() ?? null, leftEffective: p.leftEffective, accountStatus: p.accountStatus }
    await c.tx.update(staffProfile).set({ employmentStatus: 'active', leftAt: null, leftEffective: null }).where(eq(staffProfile.id, p.staffId))
    await audit(c, {
      action: 'exit.staff.rehired', entityType: 'staff_profile', entityId: p.staffId, siteId: old?.siteId ?? undefined, reason: i.reason,
      before, after: { employmentStatus: 'active', leftAt: null, leftEffective: null, sameProfile: true, accountStatus: p.accountStatus, earlierCaseId: old?.id ?? null, earlierCaseOpen: !!openCaseId },
    })
    const cycle = p.leftAt?.getTime() ?? 0
    await notify(c.tx, {
      dedupeKey: `staff:${p.staffId}:rehired:${cycle}`, kind: 'staff.rehired', to: old?.siteId ? { role: 'AA', siteId: old.siteId } : { role: 'AA' }, ref: { type: 'staff_profile', id: p.staffId },
      text: `${p.fullName} (${p.employeeId}) was rehired: the existing profile is active again. ${p.userId ? 'Their login stays off until it is reactivated in Users & access.' : 'They have no login account yet.'}`,
    })
    return ok<RehireOut>({
      staffId: p.staffId, employeeId: p.employeeId, fullName: p.fullName, employmentStatus: 'active', previousLeftEffective: p.leftEffective, openCaseId,
      account: p.userId ? (i.reactivateAccount ? 'still_disabled' : 'not_requested') : 'none',
    }, `${p.fullName} is active again on the same profile (${p.employeeId}).${openCaseId ? ' An earlier clearance case is fully resolved but still open: close it before any new exit.' : ''}`)
  })
  if (!first.ok || !i.reactivateAccount || first.data.account !== 'still_disabled') return first

  // Second step, its own transaction: the login. The profile above is committed whatever happens here.
  if (!accountUserId) return ok({ ...first.data, account: 'none' as const })
  const r = await reactivateAccount(rc, { userId: accountUserId, reason: i.reason })
  if (r.ok) {
    return ok({ ...first.data, account: 'reactivated' as const, temporaryPassword: r.data.temporaryPassword, username: r.data.username },
      `${first.data.fullName} is active again and can sign in with a new temporary password. It is shown once: hand it over now.`)
  }
  return ok({ ...first.data, account: 'still_disabled' as const, accountProblem: { reason: r.reason, owner: r.owner, next: r.next } },
    `Profile reactivated; account still disabled, retry from Users & access. ${r.reason}`)
}
