/**
 * Helpers shared by the WP-D commands (requests, exceptions, reservations, bulk allocation): input building blocks,
 * the request loader with the right lock, separation-of-duties for decisions, notification fan-out and a bed label.
 *
 * Locking order, everywhere: staff (submit only) -> request -> bed (inside allocateBed) . A command that touches a
 * request locks it FOR UPDATE before it reads the status it is about to change.
 */
import { and, eq, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import { accommodationRequest, auditEvent, bed, building, room, site, staffProfile, userAccount } from '@/server/db/schema'
import { requestExceptionAsk } from '@/server/db/schema.requests'
import type { CommandContext, Tx } from '@/server/command/context'
import { fail, failure, type Failure } from '@/server/command/result'
import { notSelf } from '@/server/command/authorize'
import { authorizeEscalated } from '@/server/approvals/escalation'
import { notify } from '@/server/notify'
import { STAY_TYPES } from '@/domain/enums'
import { idSchema, reasonSchema, optionalText, todayInZone } from '@/server/commands/property/shared'

export { idSchema, reasonSchema, optionalText, todayInZone }

export type RequestRow = typeof accommodationRequest.$inferSelect

/** A request the person still has "in the air": one per person (Request != Reservation != Stay). */
export const OPEN_STATUSES = ['submitted', 'pending_approval', 'changes_requested'] as const

/**
 * The expected arrival time on the arrival date. The request form carries a date only, so the no-show clock (D-58,
 * eta + timers.no_show_hours) starts from midday UTC on that date until Grand Hyatt says otherwise.
 */
// OPEN: arrival time of day is not captured on the request (D-58 says "24h after the planned arrival date"); noon UTC until decided.
export const DEFAULT_ETA_HOUR_UTC = 12
export const etaFor = (arrivalDate: string): Date => new Date(`${arrivalDate}T${String(DEFAULT_ETA_HOUR_UTC).padStart(2, '0')}:00:00Z`)

export const dateSchema = z.iso.date('Use a date like 2026-11-30')
export const stayTypeSchema = z.enum(STAY_TYPES, { error: 'Choose permanent, contract or trainee' })
export const noteSchema = optionalText(500)

export async function loadRequest(tx: Tx, id: string, lock = false): Promise<RequestRow | undefined> {
  const q = tx.select().from(accommodationRequest).where(eq(accommodationRequest.id, id))
  return lock ? (await q.for('update'))[0] : (await q)[0]
}

export async function loadStaff(tx: Tx, id: string) {
  const [s] = await tx.select({ id: staffProfile.id, employeeId: staffProfile.employeeId, fullName: staffProfile.fullName, employmentStatus: staffProfile.employmentStatus, archivedAt: staffProfile.archivedAt })
    .from(staffProfile).where(eq(staffProfile.id, id))
  return s
}

/** The staff record that belongs to a login (the person who submitted or decided), if any. */
export async function staffIdOfUser(tx: Tx, userId: string | null | undefined): Promise<string | undefined> {
  if (!userId) return undefined
  const [u] = await tx.select({ staffId: userAccount.staffId }).from(userAccount).where(eq(userAccount.id, userId))
  return u?.staffId ?? undefined
}

/** The label of a bed for messages: "Bed B2, Room 101, Palm Villas". */
export async function bedLabel(tx: Pick<Tx, 'select'>, bedId: string) {
  const [b] = await tx.select({
    code: bed.code, siteId: bed.siteId, roomName: room.name, siteName: site.name, buildingName: building.name,
  }).from(bed).innerJoin(room, eq(room.id, bed.roomId)).innerJoin(site, eq(site.id, bed.siteId)).leftJoin(building, eq(building.id, room.buildingId))
    .where(eq(bed.id, bedId))
  if (!b) return undefined
  return { ...b, label: `Bed ${b.code}, Room ${b.roomName}${b.buildingName ? `, ${b.buildingName}` : ''}, ${b.siteName}` }
}

/** The requester: the person themselves, or the officer who submitted on their behalf. */
export const isRequester = (c: Pick<CommandContext, 'actor' | 'user'>, r: Pick<RequestRow, 'staffId' | 'submittedBy'>): boolean =>
  (c.actor.staffId !== undefined && r.staffId === c.actor.staffId) || r.submittedBy === c.user.id

/**
 * May this actor approve, reject or send back this request right now? Accommodation Admin and Super Admin at any time within scope;
 * a Policy Approver or Backup Approver only from the backup level of the approval clock and only while `approvals.escalation_backup` is
 * on (P-01, proposed, pending client sign-off). The same rule the approvals inbox applies (src/server/approvals/escalation.ts).
 * The clock runs from when the request reached the admin: filing, or the last resubmission or exception decision (`updatedAt`).
 */
export function authorizeRequestDecision(c: CommandContext, r: Pick<RequestRow, 'siteId' | 'updatedAt'>): Promise<Failure | undefined> {
  return authorizeEscalated(c, { primary: 'requests_waitlist.approve', siteId: r.siteId, since: r.updatedAt, first: { text: 'the Accommodation Admin', owner: 'Accommodation Admin' } })
}

/**
 * Separation of duties for a decision on a request (D-26): never the person it is about, and never the officer who
 * raised it on their behalf (the inbox shows the same reason on the card).
 */
export function decisionSod(c: Pick<CommandContext, 'actor' | 'user'>, r: Pick<RequestRow, 'staffId' | 'submittedBy' | 'onBehalf'>, what: string): Failure | undefined {
  const self = notSelf(c, r.staffId, what)
  if (self) return self
  if (r.onBehalf && r.submittedBy === c.user.id) {
    return fail.sod(`You submitted this request on someone's behalf, so you cannot ${what} yourself`, 'A different Accommodation Admin or Super Admin decides it (D-26)')
  }
  return undefined
}

/** The wording for a request that is not in the state a command needs. Says where it is, who owns it, what to do. */
export function wrongState(r: Pick<RequestRow, 'status'>, wanted: string): Failure {
  switch (r.status) {
    case 'approved': return failure('conflict', `This request is already approved and has a reservation, so it cannot be ${wanted}`, { owner: 'Accommodation Admin', next: 'Cancel the reservation if the bed is no longer needed' })
    case 'pending_approval': return failure('conflict', `This request is waiting for a Policy Approver's decision on an exception, so it cannot be ${wanted} yet`, { owner: 'Policy Approver', next: 'Wait for the exception decision, or cancel the request' })
    case 'changes_requested': return failure('conflict', `This request was sent back to the requester for changes, so it cannot be ${wanted} yet`, { owner: 'The requester', next: 'The requester edits and resubmits it' })
    case 'rejected': return failure('conflict', `This request was rejected, so it cannot be ${wanted}`, { owner: 'The requester', next: 'Submit a new request if the need is still there' })
    case 'cancelled': return failure('conflict', `This request was cancelled, so it cannot be ${wanted}`, { owner: 'The requester', next: 'Submit a new request if the need is still there' })
    case 'waitlisted': return failure('conflict', `This request is on the waitlist, so it cannot be ${wanted}`, { owner: 'Accommodation Admin', next: 'Use the waitlist: an offer turns it into a reservation' })
    default: return failure('conflict', `This request is ${r.status.replace(/_/g, ' ')}, so it cannot be ${wanted}`, { owner: 'Accommodation Admin', next: 'Open the request to see where it stands' })
  }
}

/**
 * Tells the person the request is about, and the officer who submitted it for them (when that is somebody else).
 * Keys come from the event, never the clock, so a retried command notifies once (AT-030).
 */
export async function notifyRequester(
  tx: Tx, r: Pick<RequestRow, 'id' | 'staffId' | 'submittedBy' | 'onBehalf'>, key: string, kind: string, text: string, opts: { except?: string } = {},
) {
  if (r.staffId !== opts.except) await notify(tx, { dedupeKey: `${key}:resident`, kind, to: { staffId: r.staffId }, text, ref: { type: 'request', id: r.id } })
  if (r.onBehalf) {
    const sub = await staffIdOfUser(tx, r.submittedBy)
    if (sub && sub !== r.staffId && sub !== opts.except) await notify(tx, { dedupeKey: `${key}:submitter`, kind, to: { staffId: sub }, text, ref: { type: 'request', id: r.id } })
  }
}

/** Withdraws the open exception ask of a request (it was cancelled, rejected or sent back). */
export async function withdrawOpenAsk(c: CommandContext, requestId: string): Promise<string | undefined> {
  const rows = await c.tx.update(requestExceptionAsk)
    .set({ status: 'withdrawn', decidedBy: c.user.id, decidedAt: c.now, decisionReason: 'The request was closed or sent back before a decision' })
    .where(and(eq(requestExceptionAsk.requestId, requestId), eq(requestExceptionAsk.status, 'asked'))).returning({ id: requestExceptionAsk.id })
  return rows[0]?.id
}

/** How many times this request has been sent back so far: the revision, used to key "resubmitted" notifications. */
export async function revisionOf(tx: Tx, requestId: string): Promise<number> {
  const [r] = await tx.select({ n: sql<number>`count(*)::int` }).from(auditEvent)
    .where(and(eq(auditEvent.entityId, requestId), inArray(auditEvent.action, ['requests.request.changes_requested'])))
  return r.n
}

/** Snapshot for audit rows: small, stable, no timestamps. */
export const snapRequest = (r: RequestRow) => ({
  staffId: r.staffId, siteId: r.siteId, arrivalDate: r.arrivalDate, endDate: r.endDate, stayType: r.stayType, status: r.status, note: r.note,
})
