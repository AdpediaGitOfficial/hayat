/**
 * What Mark as Left would do to a person, counted without changing anything: the preview on /exits/new and the rows of the bulk
 * preview. The numbers use the same rules the command applies (the same statuses), so "will happen" and "happened" agree.
 */
import { and, count, eq, inArray, isNull, or } from 'drizzle-orm'
import { accommodationRequest, staffProfile, userAccount } from '@/server/db/schema'
import { emergencyCheckin } from '@/server/db/schema.emergency'
import { checkoutRequest, extensionRequest, transferRequest } from '@/server/db/schema.stays'
import { bedOffer, waitlistEntry } from '@/server/db/schema.waitlist'
import { session } from '@/server/db/schema'
import type { Db } from '@/server/db/client'
import { outstandingHandovers } from '@/server/handover/outstanding'
import { exitStay, futureReservations, type StaySummary } from '@/server/commands/exit/shared'

type Reader = Pick<Db, 'select'>

export interface ExitImpact {
  stay: StaySummary | null
  reservations: number
  openRequests: number
  waitlistEntries: number
  pendingOffers: number
  transfers: number
  extensions: number
  checkoutRequests: number
  pendingEmergency: number
  keysHeld: number
  hasAccount: boolean
  accountStatus: string | null
  liveSessions: number
}

const n = async (q: Promise<{ n: number }[]>) => Number((await q)[0]?.n ?? 0)

export async function exitImpact(q: Reader, staffId: string): Promise<ExitImpact> {
  const stay = (await exitStay(q, staffId)) ?? null
  const [acct] = await q.select({ id: userAccount.id, status: userAccount.status }).from(userAccount).where(eq(userAccount.staffId, staffId)).limit(1)
  return {
    stay,
    reservations: (await futureReservations(q, staffId)).length,
    openRequests: await n(q.select({ n: count() }).from(accommodationRequest).where(and(eq(accommodationRequest.staffId, staffId), inArray(accommodationRequest.status, ['submitted', 'pending_approval', 'changes_requested'])))),
    waitlistEntries: await n(q.select({ n: count() }).from(waitlistEntry).where(and(eq(waitlistEntry.staffId, staffId), inArray(waitlistEntry.status, ['waiting', 'offered'])))),
    pendingOffers: await n(q.select({ n: count() }).from(bedOffer).where(and(eq(bedOffer.staffId, staffId), eq(bedOffer.status, 'pending')))),
    transfers: await n(q.select({ n: count() }).from(transferRequest).where(and(or(eq(transferRequest.staffId, staffId), eq(transferRequest.otherStaffId, staffId)), inArray(transferRequest.status, ['requested', 'approved', 'failed'])))),
    extensions: await n(q.select({ n: count() }).from(extensionRequest).where(and(eq(extensionRequest.staffId, staffId), eq(extensionRequest.status, 'requested')))),
    checkoutRequests: await n(q.select({ n: count() }).from(checkoutRequest).where(and(eq(checkoutRequest.staffId, staffId), inArray(checkoutRequest.status, ['requested', 'acknowledged'])))),
    pendingEmergency: await n(q.select({ n: count() }).from(emergencyCheckin).where(and(eq(emergencyCheckin.staffId, staffId), eq(emergencyCheckin.status, 'pending')))),
    keysHeld: (await outstandingHandovers(q, staffId)).length,
    hasAccount: !!acct,
    accountStatus: acct?.status ?? null,
    liveSessions: acct ? await n(q.select({ n: count() }).from(session).where(and(eq(session.userId, acct.id), isNull(session.revokedAt)))) : 0,
  }
}

const plural = (k: number, one: string, many = one + 's') => `${k} ${k === 1 ? one : many}`

/** The sentences shown before anyone confirms. The first two are always true: the stay stays, the login ends now. */
export function describeImpact(x: ExitImpact): string[] {
  const out: string[] = []
  out.push(x.stay && (x.stay.status === 'active' || x.stay.status === 'provisional' || x.stay.status === 'resolution_pending')
    ? `The stay stays: they remain in bed ${x.stay.bedCode} (${x.stay.siteName}) until an actual checkout. The bed is not released.`
    : x.stay ? `They already checked out of bed ${x.stay.bedCode}; the clearance case will track what is still outstanding.` : 'They have no stay, so no bed is involved.')
  out.push(x.hasAccount ? `Their login ends now${x.liveSessions ? ` and ${plural(x.liveSessions, 'signed-in session')} end${x.liveSessions === 1 ? 's' : ''} at once` : ''}.` : 'They have no login account, so there is nothing to end.')
  if (x.reservations) out.push(`${plural(x.reservations, 'future reservation')} will be cancelled and the beds released.`)
  if (x.waitlistEntries) out.push(`${plural(x.waitlistEntries, 'waitlist entry', 'waitlist entries')} will be closed${x.pendingOffers ? ` and ${plural(x.pendingOffers, 'bed offer')} withdrawn` : ''}.`)
  if (x.openRequests) out.push(`${plural(x.openRequests, 'open accommodation request')} will be cancelled.`)
  const moves = x.transfers + x.extensions + x.checkoutRequests
  if (moves) out.push(`${plural(moves, 'pending move, extension or checkout request')} will be cancelled.`)
  if (x.pendingEmergency) out.push('A pending emergency check-in approval will become part of the clearance case.')
  if (x.keysHeld) out.push(`${plural(x.keysHeld, 'key or asset')} still held will be added to the clearance case.`)
  out.push('A clearance case opens with the checklist; the Policy Approver and Reception are notified.')
  return out
}
