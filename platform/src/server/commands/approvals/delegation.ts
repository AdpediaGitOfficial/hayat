/**
 * Out-of-office delegation (D-32): an approver names a stand-in and a date range for themselves.
 * It is a RECORD, not a grant (docs/STAGE-2.md S-13, S-14): the stand-in must already hold an approver role in the same site
 * scope, gains no action and no site from it, and is simply told when something waits for the person they cover
 * (jobs/sweeps/requests.ts). Everything is audited.
 */
import { and, eq, gte, isNull, lte, sql } from 'drizzle-orm'
import { z } from 'zod'
import { delegation, staffProfile, userAccount } from '@/server/db/schema'
import { audit } from '@/server/audit'
import { loadAccess } from '@/server/auth/actor'
import { runCommand } from '@/server/command/run'
import type { RequestContext } from '@/server/command/context'
import { fail, failure, ok, type Result } from '@/server/command/result'
import { notify } from '@/server/notify'
import { fmtDate } from '@/domain/time'
import { dateSchema, idSchema, optionalText } from '@/server/commands/requests/shared'
import { approverScope, isApprover, sharesApproverScope } from './approvers'

const MAX_DAYS = 366

export const createInput = z.object({
  /** The stand-in, by login id or by employee ID. */
  toUserId: idSchema.optional(),
  toEmployeeId: z.string().trim().min(1, 'Required').max(40).optional(),
  startsOn: dateSchema,
  /** The last day of the absence. */
  endsOn: dateSchema,
  reason: optionalText(300),
}).refine(v => Boolean(v.toUserId) !== Boolean(v.toEmployeeId), { message: 'Name the stand-in by login id or by employee ID', path: ['toEmployeeId'] })
export type CreateDelegationInput = z.infer<typeof createInput>

export function createDelegation(rc: RequestContext, i: CreateDelegationInput): Promise<Result<{ delegationId: string }>> {
  return runCommand(rc, async c => {
    // The person delegating must be an approver of something.
    const mine = await loadAccess(c.tx, c.user.id, c.now)
    const mineScope = approverScope(mine, c.user.staffId)
    if (!isApprover(mineScope)) return fail.forbidden('set a stand-in because you do not approve anything', 'An administrator can give you an approver role')

    // The stand-in: a live login.
    const [to] = await c.tx.select({ id: userAccount.id, staffId: userAccount.staffId, status: userAccount.status, name: staffProfile.fullName, archivedAt: userAccount.archivedAt })
      .from(userAccount).leftJoin(staffProfile, eq(staffProfile.id, userAccount.staffId))
      .where(i.toUserId ? eq(userAccount.id, i.toUserId) : sql`lower(btrim(${staffProfile.employeeId})) = ${(i.toEmployeeId ?? '').trim().toLowerCase()}`)
    if (!to || to.archivedAt) return fail.invalid('No active login matches that stand-in', { toEmployeeId: 'Check the employee ID. The stand-in needs a login' })
    if (to.id === c.user.id) return fail.invalid('You cannot be your own stand-in', { toEmployeeId: 'Choose a colleague' })
    if (to.status !== 'active') return fail.invalid(`${to.name ?? 'That person'}'s login is not active`, { toEmployeeId: 'Choose a colleague with an active login' })
    const theirs = await loadAccess(c.tx, to.id, c.now)
    if (!sharesApproverScope(mineScope, approverScope(theirs, to.staffId ?? undefined))) {
      return failure('conflict', `${to.name ?? 'That person'} does not approve the same things at your sites, so they cannot cover for you`, {
        owner: 'Super Admin', next: 'Choose a colleague who already holds the role at your site. A stand-in never gains authority from this (S-13)', detail: { reason: 'not_an_approver' },
      })
    }

    // The dates.
    const today = c.now.toISOString().slice(0, 10)
    const fields: Record<string, string> = {}
    if (i.startsOn < today) fields.startsOn = `The first day can't be in the past (today is ${today})`
    if (i.endsOn < i.startsOn) fields.endsOn = 'The last day must be on or after the first day'
    else if ((Date.parse(i.endsOn) - Date.parse(i.startsOn)) / 86_400_000 > MAX_DAYS) fields.endsOn = `At most ${MAX_DAYS} days`
    if (Object.keys(fields).length) return fail.invalid('Check the dates', fields)

    const [clash] = await c.tx.select({ id: delegation.id }).from(delegation).where(and(
      eq(delegation.fromUserId, c.user.id), isNull(delegation.revokedAt), lte(delegation.startsOn, i.endsOn), gte(delegation.endsOn, i.startsOn))).limit(1)
    if (clash) return failure('conflict', 'You already have a stand-in for some of those dates', { owner: 'You', next: 'Revoke the existing delegation first, or choose other dates', detail: { reason: 'overlap', delegationId: clash.id } })

    const [row] = await c.tx.insert(delegation).values({
      fromUserId: c.user.id, toUserId: to.id, startsOn: i.startsOn, endsOn: i.endsOn, reason: i.reason, createdBy: c.user.id,
    }).returning({ id: delegation.id })
    await audit(c, { action: 'approvals.delegation.created', entityType: 'delegation', entityId: row.id, reason: i.reason ?? undefined, after: { fromUserId: c.user.id, toUserId: to.id, startsOn: i.startsOn, endsOn: i.endsOn } })
    if (to.staffId) {
      await notify(c.tx, {
        dedupeKey: `delegation:${row.id}:created`, kind: 'delegation.created', to: { staffId: to.staffId }, ref: { type: 'delegation', id: row.id },
        text: `${c.user.username} named you as their stand-in from ${fmtDate(i.startsOn)} to ${fmtDate(i.endsOn)}. You decide only what your own role allows; you will be reminded of what waits for them.`,
      })
    }
    return ok({ delegationId: row.id }, `${to.name ?? 'Your stand-in'} will be reminded of what waits for you from ${fmtDate(i.startsOn)} to ${fmtDate(i.endsOn)}.`)
  })
}

export const revokeInput = z.object({ delegationId: idSchema })

/** Ends a delegation now. The person who set it, or a Super Admin, may do it. */
export function revokeDelegation(rc: RequestContext, i: z.infer<typeof revokeInput>): Promise<Result<{ delegationId: string }>> {
  return runCommand(rc, async c => {
    const [d] = await c.tx.select().from(delegation).where(eq(delegation.id, i.delegationId)).for('update')
    if (!d || (d.fromUserId !== c.user.id && c.actor.role !== 'SA')) return fail.notFound()
    if (d.revokedAt) return ok({ delegationId: d.id }, 'Already ended.')
    await c.tx.update(delegation).set({ revokedAt: c.now }).where(eq(delegation.id, d.id))
    await audit(c, { action: 'approvals.delegation.revoked', entityType: 'delegation', entityId: d.id, before: { startsOn: d.startsOn, endsOn: d.endsOn, toUserId: d.toUserId }, after: { revokedAt: c.now.toISOString() } })
    const [to] = await c.tx.select({ staffId: userAccount.staffId }).from(userAccount).where(eq(userAccount.id, d.toUserId))
    if (to?.staffId) {
      await notify(c.tx, { dedupeKey: `delegation:${d.id}:revoked`, kind: 'delegation.revoked', to: { staffId: to.staffId }, ref: { type: 'delegation', id: d.id }, text: 'A delegation that named you as stand-in was ended.' })
    }
    return ok({ delegationId: d.id }, 'Delegation ended.')
  })
}
