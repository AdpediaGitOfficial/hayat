/**
 * Validation shared by submit, edit and resubmit: who may use which site, and what the dates must look like (D-103).
 */
import { and, eq, inArray } from 'drizzle-orm'
import { reservation, site, stay, waitlistEntry } from '@/server/db/schema'
import type { CommandContext, Tx } from '@/server/command/context'
import { fail, failure, type Failure } from '@/server/command/result'
import { decide } from '@/server/policy'
import { OCCUPYING_STAY_STATUSES, type StayTypeDb } from '@/domain/enums'
import { todayInZone } from './shared'

type SiteRow = typeof site.$inferSelect

/**
 * May this actor file a request for this person at this site? A Resident only for themselves, at any site; Reception and
 * Accommodation Admins on behalf of anyone, but only at their own sites. A site outside the officer's scope is a field
 * error (the form never offers it), not a hidden record.
 */
export function checkSubmitAccess(c: Pick<CommandContext, 'actor'>, siteId: string, staffId: string): Failure | undefined {
  if (c.actor.role === 'Res' && c.actor.staffId !== staffId) {
    return fail.forbidden('request a bed for someone else', 'Reception or an Accommodation Admin')
  }
  const d = decide(c.actor, 'requests_waitlist.submit', { siteId, ownerStaffId: staffId })
  if (d.allowed) return undefined
  if (d.reason === 'out_of_scope') return fail.invalid('You can only file requests for your own sites', { siteId: 'Choose one of your sites' })
  return fail.forbidden('submit requests')
}

export interface Fields { siteId: string; arrivalDate: string; endDate: string | null; stayType: StayTypeDb }

/** Site must exist and be live; dates follow D-103 (end = departure day, after arrival; open-ended only for permanent). */
export async function validateFields(c: CommandContext, v: Fields): Promise<Failure | { site: SiteRow }> {
  const [s] = await c.tx.select().from(site).where(eq(site.id, v.siteId))
  if (!s || s.archivedAt) return fail.invalid('That site is not available for requests', { siteId: 'Choose an active site' })
  const today = todayInZone(c.now, s.timeZone)
  const fields: Record<string, string> = {}
  if (v.arrivalDate < today) fields.arrivalDate = `Arrival can't be in the past (today is ${today})`
  if (v.endDate !== null) {
    if (v.endDate <= v.arrivalDate) fields.endDate = 'The departure day must be after the arrival day'
  } else if (v.stayType !== 'permanent') {
    fields.endDate = 'A planned end date is required unless the stay is permanent'
  }
  if (Object.keys(fields).length) return fail.invalid('Check the dates', fields)
  return { site: s }
}

/** Is this person already housed or queued? Those are other workflows (transfer, extension, waitlist), not a new request. */
export async function alreadyProvided(tx: Pick<Tx, 'select'>, staffId: string, name: string): Promise<Failure | undefined> {
  const [st] = await tx.select({ id: stay.id }).from(stay).where(and(eq(stay.staffId, staffId), inArray(stay.status, [...OCCUPYING_STAY_STATUSES]))).limit(1)
  if (st) return failure('conflict', `${name} already has a bed`, { owner: 'Reception', next: 'Ask for a transfer or an extension of the current stay instead', detail: { reason: 'has_stay', stayId: st.id } })
  const [rv] = await tx.select({ id: reservation.id }).from(reservation).where(and(eq(reservation.staffId, staffId), eq(reservation.status, 'reserved'))).limit(1)
  if (rv) return failure('conflict', `${name} already has a reservation`, { owner: 'Accommodation Admin', next: 'Keep the reservation, or have it cancelled first', detail: { reason: 'has_reservation', reservationId: rv.id } })
  const [wl] = await tx.select({ id: waitlistEntry.id }).from(waitlistEntry).where(and(eq(waitlistEntry.staffId, staffId), inArray(waitlistEntry.status, ['waiting', 'offered']))).limit(1)
  if (wl) return failure('conflict', `${name} is already on the waitlist`, { owner: 'Accommodation Admin', next: 'The waitlist will offer a bed when one is free', detail: { reason: 'on_waitlist', waitlistEntryId: wl.id } })
  return undefined
}
