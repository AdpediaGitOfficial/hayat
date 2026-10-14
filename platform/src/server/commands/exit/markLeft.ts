/**
 * Mark as Left (D-35, AT-019). ONE transaction, all or nothing, in this order:
 *
 *   authorize (site of the person's live stay or reservation) -> nobody marks themselves (D-26) -> re-confirm the password (D-03)
 *   -> the last Super Admin is protected (D-27) -> already Left? -> employment Left, login revoked and EVERY session ended
 *   -> the cascade of D-36 -> the clearance case and its items -> the pending emergency approval becomes part of the case -> audit -> notify.
 *
 * What it does NOT do: touch the stay or the bed. The resident stays in the bed until an actual checkout (D-35, D-64); the stay
 * is only flagged through the clearance case. Login is revoked at once whatever the effective date says: the future-dated policy
 * (D-37) is open and `exit.login_revocation` is only "immediate".
 */
import { and, eq, inArray, or, sql } from 'drizzle-orm'
import { z } from 'zod'
import { accommodationRequest, reservation, site as siteTable, staffProfile, stay as stayTable, userAccount } from '@/server/db/schema'
import { checkoutRequest, extensionRequest, transferRequest } from '@/server/db/schema.stays'
import { clearanceCase, clearanceItem } from '@/server/db/schema.exit'
import { audit } from '@/server/audit'
import { notSelf } from '@/server/command/authorize'
import { runCommand } from '@/server/command/run'
import type { CommandContext, RequestContext } from '@/server/command/context'
import { fail, failure, ok, type Result } from '@/server/command/result'
import { confirmPassword } from '@/server/auth/reauth'
import { revokeAllSessions } from '@/server/auth/session'
import { releaseClaim } from '@/server/allocation'
import { notify } from '@/server/notify'
import { getConfig } from '@/server/config/registry'
import { loadCalendar } from '@/server/eligibility'
import { outstandingHandovers } from '@/server/handover/outstanding'
import { closeEntriesForStaff, withdrawOffersForStaff } from '@/server/commands/waitlist'
import { convertEmergencyForExit } from '@/server/commands/emergency/convertForExit'
import { withdrawOpenAsk, snapRequest } from '@/server/commands/requests/shared'
import { isFullSuperAdmin, loadTarget, lockSuperAdmins, lastSuperAdminFailure, notYoursToManage } from '@/server/commands/access/guards'
import { todayInZone } from '@/server/commands/property/shared'
import { exitCascadeSteps } from './cascade'
import { addBusinessDays } from './rules'
import {
  authorizeAtSite, exitSiteId, exitStay, futureReservations, handoverLabel, holdsSuperAdmin, idSchema, itemTypeLabels, latestCaseFor, loadPerson, logEvent, reasonSchema,
  OPEN_CASE_STATUSES, type PersonFacts,
} from './shared'

export const markLeftInput = z.object({
  staffId: idSchema,
  effectiveDate: z.iso.date('Use a date like 2026-11-30'),
  reason: reasonSchema,
  confirmPassword: z.string().max(200).optional(),
})
export type MarkLeftInput = z.infer<typeof markLeftInput>

export interface CascadeCounts {
  offersWithdrawn: number
  waitlistEntriesClosed: number
  requestsCancelled: number
  reservationsCancelled: number
  transfersCancelled: number
  extensionsCancelled: number
  checkoutRequestsCancelled: number
  emergencyConverted: number
  other: { label: string; count: number }[]
}
export interface MarkLeftOut {
  caseId: string
  staffId: string
  employeeId: string
  fullName: string
  effectiveDate: string
  dueDate: string
  siteId: string | null
  stayId: string | null
  /** The resident is still in the bed after Mark as Left (D-35). False when there was no live stay. */
  stillInBed: boolean
  accountRevoked: boolean
  sessionsEnded: number
  itemsOpened: number
  cascade: CascadeCounts
  /** True when this was a repeat of a call that had already been done. */
  repeated: boolean
}

const REASON_PREFIX = 'Marked as Left: '

export function markLeft(rc: RequestContext, i: MarkLeftInput): Promise<Result<MarkLeftOut>> {
  return runCommand(rc, c => markLeftIn(c, i, {}))
}

/** The whole of Mark as Left inside the caller's transaction. Bulk exit calls it once per row after re-confirming the password once. */
export async function markLeftIn(c: CommandContext, i: MarkLeftInput, o: { passwordChecked?: boolean }): Promise<Result<MarkLeftOut>> {
  const p0 = await loadPerson(c.tx, i.staffId)
  if (!p0 || p0.archivedAt) return fail.notFound()
  const earlier = p0.employmentStatus === 'left' ? await latestCaseFor(c.tx, i.staffId) : undefined
  const siteId0 = (await exitSiteId(c.tx, i.staffId)) ?? earlier?.siteId ?? undefined

  // 1. may this actor do this to this person? Out of scope reads as "not found".
  const denied = authorizeAtSite(c, 'exit_clearance.mark_left', siteId0)
  if (denied) return denied
  // 2. nobody marks themselves Left (D-26)
  const self = notSelf(c, i.staffId, 'mark an employee as Left')
  if (self) return self
  // 3. an administrator's account is a Super Admin's to end (D-08), the same rule as deactivating it
  if (p0.userId) {
    const t = await loadTarget(c.tx, p0.userId)
    if (t && t.adminType && !isFullSuperAdmin(c.actor)) return notYoursToManage(t, 'mark as Left')
  }
  // 4. re-confirm the actor's password (D-03)
  if (!o.passwordChecked) {
    const bad = await confirmPassword(c, i.confirmPassword)
    if (bad) return bad
  }
  // 5. the last active Super Admin can never be removed (D-27). The lock comes before any row lock below.
  if (p0.userId && (await holdsSuperAdmin(c.tx, p0.userId))) {
    await lockSuperAdmins(c.tx)
    const last = await lastSuperAdminFailure(c.tx, p0.userId)
    if (last) return last
  }

  // 6. lock the person and look again: two admins marking the same person at once do it once
  const p = await loadPerson(c.tx, i.staffId, true)
  if (!p || p.archivedAt) return fail.notFound()
  if (p.employmentStatus === 'left') return alreadyLeft(c, i, p)
  const siteId = (await exitSiteId(c.tx, i.staffId)) ?? undefined
  if (siteId !== siteId0) {
    const again = authorizeAtSite(c, 'exit_clearance.mark_left', siteId)
    if (again) return again
  }
  const stillOpen = await latestCaseFor(c.tx, i.staffId)
  if (stillOpen && stillOpen.status !== 'cleared') {
    return failure('conflict', 'An earlier clearance case for this person is still open', {
      owner: 'Accommodation Admin', next: 'Close the earlier case first, then mark them as Left', detail: { reason: 'open_case', caseId: stillOpen.id },
    })
  }

  const why = REASON_PREFIX + i.reason
  const [before] = await c.tx.select({ status: staffProfile.employmentStatus, leftAt: staffProfile.leftAt, leftEffective: staffProfile.leftEffective }).from(staffProfile).where(eq(staffProfile.id, p.staffId))

  // 7. employment Left; the login is revoked and every session ended in this same transaction
  await c.tx.update(staffProfile).set({ employmentStatus: 'left', leftAt: c.now, leftEffective: i.effectiveDate }).where(eq(staffProfile.id, p.staffId))
  let sessionsEnded = 0
  let accountRevoked = false
  if (p.userId) {
    await c.tx.update(userAccount).set({ status: 'revoked', revokedAt: sql`coalesce(${userAccount.revokedAt}, ${c.now.toISOString()}::timestamptz)` }).where(eq(userAccount.id, p.userId))
    sessionsEnded = await revokeAllSessions(c.tx, p.userId, 'marked_left', c.now)
    accountRevoked = true
  }

  // 8. the stay and the bed are NOT touched. Reservations that have not started are cancelled and their claims released (D-36).
  const stay = await exitStay(c.tx, p.staffId, true)
  const cascade: CascadeCounts = {
    offersWithdrawn: 0, waitlistEntriesClosed: 0, requestsCancelled: 0, reservationsCancelled: 0, transfersCancelled: 0,
    extensionsCancelled: 0, checkoutRequestsCancelled: 0, emergencyConverted: 0, other: [],
  }
  const reservations = await futureReservations(c.tx, p.staffId, true)
  for (const rv of reservations) {
    await releaseClaim(c.tx, rv.claimId, `Reservation cancelled: ${why}`, c.now)
    await c.tx.update(reservation).set({ status: 'cancelled', cancelReason: why }).where(and(eq(reservation.id, rv.id), eq(reservation.status, 'reserved')))
    await audit(c, {
      action: 'requests.reservation.cancelled', entityType: 'reservation', entityId: rv.id, siteId: rv.siteId, reason: why,
      before: { status: 'reserved', bedId: rv.bedId, claimId: rv.claimId }, after: { status: 'cancelled', claimReleased: true },
    })
    cascade.reservationsCancelled++
  }

  // 9. waitlist: the offer is withdrawn (its hold released, the next in line told), then the entry closed
  cascade.offersWithdrawn = await withdrawOffersForStaff(c, p.staffId, why)
  cascade.waitlistEntriesClosed = await closeEntriesForStaff(c, p.staffId, why)

  // 10. open requests, transfers, extensions and checkout requests are cancelled with a reason
  const reqs = await c.tx.select().from(accommodationRequest)
    .where(and(eq(accommodationRequest.staffId, p.staffId), inArray(accommodationRequest.status, ['submitted', 'pending_approval', 'changes_requested']))).for('update')
  for (const r of reqs) {
    const withdrawn = await withdrawOpenAsk(c, r.id)
    await c.tx.update(accommodationRequest).set({ status: 'cancelled', decidedBy: c.user.id, decidedAt: c.now, decisionReason: why }).where(eq(accommodationRequest.id, r.id))
    await audit(c, {
      action: 'requests.request.cancelled', entityType: 'request', entityId: r.id, siteId: r.siteId, reason: why,
      before: snapRequest(r), after: { ...snapRequest(r), status: 'cancelled', exceptionAskWithdrawn: withdrawn ?? null },
    })
    cascade.requestsCancelled++
  }
  const transfers = await c.tx.select().from(transferRequest)
    .where(and(or(eq(transferRequest.staffId, p.staffId), eq(transferRequest.otherStaffId, p.staffId)), inArray(transferRequest.status, ['requested', 'approved', 'failed']))).for('update')
  for (const t of transfers) {
    await c.tx.update(transferRequest).set({ status: 'cancelled', decidedBy: c.user.id, decidedAt: c.now, decisionReason: why }).where(eq(transferRequest.id, t.id))
    await audit(c, { action: 'stays.transfer.cancelled', entityType: 'transfer_request', entityId: t.id, siteId: t.siteId, reason: why, before: { status: t.status }, after: { status: 'cancelled' } })
    // The other party of a swap, or the person who asked, learns that it will not happen.
    const others = [t.staffId, t.otherStaffId].filter((s): s is string => !!s && s !== p.staffId)
    for (const s of others) {
      await notify(c.tx, { dedupeKey: `${t.kind}:${t.id}:cancelled:${s}`, kind: `${t.kind}.cancelled`, to: { staffId: s }, ref: { type: 'transfer_request', id: t.id }, text: `The ${t.kind} request that involved ${p.fullName} was cancelled because they have left.` })
    }
    cascade.transfersCancelled++
  }
  const extensions = await c.tx.select().from(extensionRequest).where(and(eq(extensionRequest.staffId, p.staffId), eq(extensionRequest.status, 'requested'))).for('update')
  for (const x of extensions) {
    await c.tx.update(extensionRequest).set({ status: 'cancelled', decidedBy: c.user.id, decidedAt: c.now, decisionReason: why }).where(eq(extensionRequest.id, x.id))
    await audit(c, { action: 'stays.extension.cancelled', entityType: 'extension_request', entityId: x.id, siteId: x.siteId, reason: why, before: { status: 'requested' }, after: { status: 'cancelled' } })
    cascade.extensionsCancelled++
  }
  const checkouts = await c.tx.select().from(checkoutRequest).where(and(eq(checkoutRequest.staffId, p.staffId), inArray(checkoutRequest.status, ['requested', 'acknowledged']))).for('update')
  for (const x of checkouts) {
    await c.tx.update(checkoutRequest).set({ status: 'cancelled', cancelledAt: c.now }).where(eq(checkoutRequest.id, x.id))
    await audit(c, { action: 'stays.checkout.cancelled', entityType: 'checkout_request', entityId: x.id, siteId: x.siteId, reason: why, before: { status: x.status }, after: { status: 'cancelled' } })
    cascade.checkoutRequestsCancelled++
  }

  // 11. the clearance case, with the configured checklist and one item for every key or asset still held
  const tzRow = siteId ? (await c.tx.select({ tz: siteTable.timeZone }).from(siteTable).where(eq(siteTable.id, siteId)).limit(1))[0] : undefined
  const today = todayInZone(c.now, tzRow?.tz ?? 'UTC')
  const dueDays = await getConfig(c.tx, 'clearance.due_business_days', siteId)
  const dueDate = addBusinessDays(today, dueDays, await loadCalendar(c.tx, siteId))
  const held = await outstandingHandovers(c.tx, p.staffId)
  const [kase] = await c.tx.insert(clearanceCase).values({
    staffId: p.staffId, stayId: stay?.id ?? null, siteId: siteId ?? null, effectiveDate: i.effectiveDate, reason: i.reason,
    // a key or asset already lost or damaged is a mandatory item that cannot be done by itself: the case starts as Pending items
    status: held.some(h => h.status === 'lost' || h.status === 'damaged') ? 'pending_items' : 'open',
    openedBy: c.user.id, openedAt: c.now, dueDate,
  }).returning({ id: clearanceCase.id })
  const checklist = await getConfig(c.tx, 'clearance.checklist')
  const labels = await itemTypeLabels(c.tx)
  let pos = 0
  const itemRows = [
    ...checklist.map(k => ({ caseId: kase.id, kind: 'checklist' as const, checklistKey: k.id, label: k.label, mandatory: k.mandatory, owner: k.owner, position: ++pos })),
    ...held.map(h => ({
      caseId: kase.id, kind: 'handover' as const, handoverItemId: h.id, label: handoverLabel(labels, h), mandatory: true,
      owner: h.status === 'lost' || h.status === 'damaged' ? ('AA' as const) : ('Reception' as const), position: ++pos,
    })),
  ]
  if (itemRows.length) await c.tx.insert(clearanceItem).values(itemRows)
  await logEvent(c.tx, { caseId: kase.id, kind: 'opened', actorUserId: c.user.id, onBehalfOfStaffId: p.staffId, note: `Marked as Left effective ${i.effectiveDate}: ${i.reason}`, at: c.now })

  // 12. a pending emergency approval becomes part of this case (D-36): after the case exists
  const converted = await convertEmergencyForExit(c.tx, p.staffId, { now: c.now, userId: c.user.id, role: c.actor.role, requestId: c.requestId }, { clearanceCaseId: kase.id })
  cascade.emergencyConverted = converted.length

  // 13. steps registered by later stages (visitor and contractor passes, D-36)
  for (const step of exitCascadeSteps()) {
    const r = await step.run(c, { staffId: p.staffId, caseId: kase.id, siteId, reason: why })
    if ('ok' in r) return r // a failure rolls everything back
    cascade.other.push(r)
  }

  // 14. one audit event with before and after, then the notifications (the last writes: a notification can never change business state)
  await audit(c, {
    action: 'exit.staff.marked_left', entityType: 'staff_profile', entityId: p.staffId, siteId, reason: i.reason,
    before: { employmentStatus: before.status, accountStatus: p.accountStatus, stayStatus: stay?.status ?? null, bedState: stay?.bedState ?? null, leftEffective: before.leftEffective },
    after: {
      employmentStatus: 'left', effectiveDate: i.effectiveDate, accountStatus: accountRevoked ? 'revoked' : null, sessionsEnded, caseId: kase.id, dueDate,
      stayStatus: stay?.status ?? null, stayChanged: false, bedChanged: false, bedFreed: false, itemsOpened: itemRows.length, cascade,
    },
  })
  const where = stay ? ` in bed ${stay.bedCode} (${stay.siteName})` : ''
  const text = `${p.fullName} (${p.employeeId}) was marked as Left effective ${i.effectiveDate}. Login ended. ${stay ? `Still in the bed${where} until an actual checkout. ` : ''}Clearance case opened, due ${dueDate}.`
  await notify(c.tx, { dedupeKey: `clearance:${kase.id}:opened:pa`, kind: 'exit.marked_left', to: siteId ? { role: 'PolicyApprover', siteId } : { role: 'PolicyApprover' }, ref: { type: 'clearance_case', id: kase.id }, text })
  await notify(c.tx, {
    dedupeKey: `clearance:${kase.id}:opened:rec`, kind: 'exit.clearance_opened', to: siteId ? { role: 'Rec', siteId } : { role: 'Rec' }, ref: { type: 'clearance_case', id: kase.id },
    text: `${text} Please start the clearance checklist${held.length ? ` (${held.length} key or asset item${held.length === 1 ? '' : 's'} to collect)` : ''}.`,
  })

  return ok({
    caseId: kase.id, staffId: p.staffId, employeeId: p.employeeId, fullName: p.fullName, effectiveDate: i.effectiveDate, dueDate, siteId: siteId ?? null, stayId: stay?.id ?? null,
    stillInBed: !!stay && stay.status !== 'checked_out' && stay.status !== 'closed', accountRevoked, sessionsEnded, itemsOpened: itemRows.length, cascade, repeated: false,
  }, `${p.fullName} is marked as Left. Their login has ended and a clearance case is open${stay && stay.status !== 'checked_out' ? '; they stay in the bed until an actual checkout' : ''}.`)
}

/** The person is Left already: the same call repeated returns the existing case; anything else says what was done and where to go. */
async function alreadyLeft(c: CommandContext, i: MarkLeftInput, p: PersonFacts): Promise<Result<MarkLeftOut>> {
  const k = await latestCaseFor(c.tx, p.staffId)
  if (k && k.openedBy === c.user.id && k.effectiveDate === i.effectiveDate && k.reason === i.reason) {
    const [{ n }] = await c.tx.select({ n: sql<number>`count(*)::int` }).from(clearanceItem).where(eq(clearanceItem.caseId, k.id))
    const st = k.stayId ? await c.tx.select({ status: stayTable.status }).from(stayTable).where(eq(stayTable.id, k.stayId)).limit(1) : []
    const empty: CascadeCounts = { offersWithdrawn: 0, waitlistEntriesClosed: 0, requestsCancelled: 0, reservationsCancelled: 0, transfersCancelled: 0, extensionsCancelled: 0, checkoutRequestsCancelled: 0, emergencyConverted: 0, other: [] }
    return ok({
      caseId: k.id, staffId: p.staffId, employeeId: p.employeeId, fullName: p.fullName, effectiveDate: k.effectiveDate, dueDate: k.dueDate, siteId: k.siteId, stayId: k.stayId,
      stillInBed: st.length > 0 && !['checked_out', 'closed'].includes(st[0].status), accountRevoked: p.accountStatus === 'revoked', sessionsEnded: 0, itemsOpened: n, cascade: empty, repeated: true,
    }, `${p.fullName} was already marked as Left. Nothing more was done.`)
  }
  return failure('conflict', `${p.fullName} is already marked as Left${p.leftEffective ? ` (effective ${p.leftEffective})` : ''}`, {
    owner: 'Accommodation Admin', next: k && OPEN_CASE_STATUSES.includes(k.status as (typeof OPEN_CASE_STATUSES)[number]) ? 'Open their clearance case and work the checklist' : 'Nothing to do. To bring them back, use Rehire on their staff profile',
    detail: { reason: 'already_left', caseId: k?.id ?? null },
  })
}
