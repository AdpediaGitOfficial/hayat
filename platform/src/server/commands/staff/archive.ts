import { z } from 'zod'
import { and, count, eq, inArray, isNull, ne } from 'drizzle-orm'
import { runCommand } from '@/server/command/run'
import { fail, ok, type Result } from '@/server/command/result'
import type { RequestContext } from '@/server/command/context'
import { notSelf } from '@/server/command/authorize'
import { audit } from '@/server/audit'
import { accommodationRequest, bedOffer, reservation, staffProfile, stay, userAccount, waitlistEntry } from '@/server/db/schema'
import { isUuid, requireDirectory } from './guard'

export const input = z.object({ id: z.string().uuid(), reason: z.string().trim().min(3, 'Say why (at least 3 characters)').max(500) })
export type ArchiveStaffInput = z.infer<typeof input>

export interface ArchiveBlocker { kind: string; count: number; label: string; owner: string; next: string }

/**
 * Archive only, never delete. A person who still occupies, holds or is waiting for a bed (or can still sign in) cannot be
 * archived: the refusal lists everything in the way, with who clears each and what to do.
 * The staff row is locked first; Stage 2 commands that create a reservation, request or stay for a person must take the
 * same row lock (FOR SHARE) so archive and allocation cannot interleave.
 */
export async function archiveStaff(rc: RequestContext, raw: ArchiveStaffInput): Promise<Result<{ id: string; archivedAt: Date }>> {
  return runCommand(rc, async c => {
    const denied = requireDirectory(c, 'staff_directory.manage')
    if (denied) return denied
    if (!isUuid(raw.id)) return fail.notFound()
    const [cur] = await c.tx.select({ id: staffProfile.id, archivedAt: staffProfile.archivedAt }).from(staffProfile).where(eq(staffProfile.id, raw.id)).for('update')
    if (!cur) return fail.notFound()
    const self = notSelf(c, cur.id, 'archive a profile')
    if (self) return self
    if (cur.archivedAt) return fail.conflict('This profile is already archived', 'Accommodation Admin', 'Nothing to do')

    const n = async (q: PromiseLike<{ n: number }[]>) => Number((await q)[0]?.n ?? 0)
    const id = cur.id
    const counts = {
      stay: await n(c.tx.select({ n: count() }).from(stay).where(and(eq(stay.staffId, id), ne(stay.status, 'closed'), isNull(stay.archivedAt)))),
      reservation: await n(c.tx.select({ n: count() }).from(reservation).where(and(eq(reservation.staffId, id), eq(reservation.status, 'reserved'), isNull(reservation.archivedAt)))),
      request: await n(c.tx.select({ n: count() }).from(accommodationRequest).where(and(eq(accommodationRequest.staffId, id), inArray(accommodationRequest.status, ['submitted', 'pending_approval', 'approved', 'waitlisted'])))),
      waitlist: await n(c.tx.select({ n: count() }).from(waitlistEntry).where(and(eq(waitlistEntry.staffId, id), inArray(waitlistEntry.status, ['waiting', 'offered'])))),
      offer: await n(c.tx.select({ n: count() }).from(bedOffer).where(and(eq(bedOffer.staffId, id), eq(bedOffer.status, 'pending')))),
      account: await n(c.tx.select({ n: count() }).from(userAccount).where(and(eq(userAccount.staffId, id), ne(userAccount.status, 'revoked'), isNull(userAccount.archivedAt)))),
    }
    const blockers: ArchiveBlocker[] = []
    const add = (kind: keyof typeof counts, label: string, owner: string, next: string) => { if (counts[kind] > 0) blockers.push({ kind, count: counts[kind], label, owner, next }) }
    add('stay', 'a stay that is not closed (occupying a bed, or checked out with clearance open)', 'Accommodation Admin', 'Complete checkout and clearance first')
    add('reservation', 'a live reservation', 'Accommodation Admin', 'Cancel the reservation first')
    add('request', 'an open accommodation request', 'Accommodation Admin', 'Decide or cancel the request first')
    add('waitlist', 'a waitlist entry', 'Accommodation Admin', 'Close the waitlist entry first')
    add('offer', 'a pending bed offer', 'Accommodation Admin', 'Withdraw the offer first')
    add('account', 'a login account that is still usable', 'Accommodation Admin (user accounts)', 'Deactivate the account first')
    if (blockers.length) {
      const list = blockers.map(b => `${b.count > 1 ? b.count + ' × ' : ''}${b.label}`).join('; ')
      return fail.conflict(`This profile cannot be archived yet: it has ${list}`, blockers[0].owner, blockers[0].next, { blockers })
    }

    await c.tx.update(staffProfile).set({ archivedAt: c.now, updatedAt: c.now }).where(eq(staffProfile.id, id))
    await audit(c, { action: 'staff.archived', entityType: 'staff_profile', entityId: id, reason: raw.reason, before: { archived: false }, after: { archived: true, archivedAt: c.now.toISOString() } })
    return ok({ id, archivedAt: c.now }, 'Archived. The history stays; nothing is deleted')
  })
}
