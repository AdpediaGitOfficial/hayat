import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { site } from '@/server/db/schema'
import { waitlistEntry } from '@/server/db/schema.waitlist'
import { audit } from '@/server/audit'
import { authorize, notSelf } from '@/server/command/authorize'
import { runCommand } from '@/server/command/run'
import type { RequestContext } from '@/server/command/context'
import { fail, ok, type Result } from '@/server/command/result'
import { DAY } from '@/domain/time'
import { getConfig } from '@/server/config/registry'
import { notify } from '@/server/notify'
import { todayInZone } from '@/server/commands/property/shared'
import { queuePosition } from './queue'
import { dateSchema, eligibleInPrinciple, idSchema, loadEntry } from './shared'

export const input = z.object({
  entryId: idSchema,
  /** Changed requirements. Leaving them out keeps the entry as it is. A change sends the entry to the back of the queue. */
  arrival: dateSchema.optional(),
  /** null = open-ended */
  end: dateSchema.nullable().optional(),
  note: z.string().trim().max(500).optional(),
})
export type RenewInput = z.infer<typeof input>

export interface RenewOut { entryId: string; expiresAt: string; positionBefore: number; positionAfter: number; positionKept: boolean }

/**
 * Renewal (D-48), a direct action of the Accommodation Admin (APPROVALS.md: AA primary; the Policy Approver is the backup
 * when the AA has not acted, which the reminders to the AA and the entry's countdown make visible).
 *
 * OPEN (GH-05, Grand Hyatt has not confirmed): the rule below is the recommended default, kept in this one place.
 *  - eligibility is revalidated; a person who is no longer eligible cannot be renewed,
 *  - renewed BEFORE expiry with the requirements unchanged: the queue position is kept,
 *  - renewed with changed dates: the entry goes to the back of the queue (new timestamp),
 *  - an entry that already expired is closed; it cannot be renewed, the person is added again at the back.
 * Nobody renews their own entry (D-26).
 */
export function renewEntry(rc: RequestContext, i: RenewInput): Promise<Result<RenewOut>> {
  return runCommand(rc, async c => {
    const peek = await loadEntry(c.tx, i.entryId)
    if (!peek) return fail.notFound()
    const denied = authorize(c, 'requests_waitlist.manage_waitlist', { siteId: peek.siteId })
    if (denied) return denied
    const sod = notSelf(c, peek.staffId, 'renew a waitlist entry')
    if (sod) return sod

    const e = await loadEntry(c.tx, i.entryId, true)
    if (!e) return fail.notFound()
    if (e.status === 'closed') {
      return fail.conflict(`This entry is closed (${e.closeReason ?? 'closed'}), so it cannot be renewed`, 'Accommodation Admin', 'Add the person to the waitlist again; they join at the back of the queue', { reason: 'entry_closed' })
    }
    if (e.expiresAt.getTime() <= c.now.getTime()) {
      return fail.conflict('This entry has passed its expiry date, so it can no longer keep its place', 'Accommodation Admin', 'The next waitlist sweep closes it; add the person again, at the back of the queue', { reason: 'entry_expired' })
    }

    const arrival = i.arrival ?? e.arrivalDate
    const end = i.end === undefined ? e.endDate : i.end
    const changed = arrival !== e.arrivalDate || end !== e.endDate
    if (end !== null && end <= arrival) return fail.invalid('The departure day must be after the arrival day', { end: 'Choose a day after the arrival' })
    if (changed) {
      const [s] = await c.tx.select({ tz: site.timeZone }).from(site).where(eq(site.id, e.siteId)).limit(1)
      const today = todayInZone(c.now, s?.tz ?? 'UTC')
      if (arrival < today) return fail.invalid('The arrival day is already past', { arrival: `Choose ${today} or later` })
      if (e.status === 'offered') {
        return fail.conflict('A bed offer is out for this entry, so its dates cannot change now', 'Accommodation Admin', 'Withdraw the offer first, then change the dates', { reason: 'offer_pending' })
      }
    }

    const fit = await eligibleInPrinciple(c.tx, e.staffId, e.siteId, c.now, e.requestId ?? undefined)
    if (!fit.ok) {
      return fail.conflict(`Not eligible any more: ${fit.reasons.join('; ')}`, fit.exceptionable ? 'Policy Approver' : 'Accommodation Admin',
        fit.exceptionable ? 'Ask a Policy Approver for an exception, then renew' : 'Let the entry lapse or take the person off the waitlist', { reason: 'not_eligible' })
    }

    const before = { expiresAt: e.expiresAt.toISOString(), position: await queuePosition(c.tx, e.siteId, e.id) ?? 0, renewals: e.renewals, remindersSent: e.remindersSent, arrival: e.arrivalDate, end: e.endDate }
    const days = await getConfig(c.tx, 'timers.waitlist_entry_days')
    const expiresAt = new Date(c.now.getTime() + days * DAY)
    await c.tx.update(waitlistEntry).set({
      expiresAt, renewals: e.renewals + 1, remindersSent: [], arrivalDate: arrival, endDate: end,
      ...(changed ? { queueTs: c.now } : {}),
    }).where(eq(waitlistEntry.id, e.id))
    const after = (await queuePosition(c.tx, e.siteId, e.id)) ?? 0
    await audit(c, {
      action: 'waitlist.entry.renewed', entityType: 'waitlist_entry', entityId: e.id, siteId: e.siteId, reason: i.note,
      before, after: { expiresAt: expiresAt.toISOString(), position: after, renewals: e.renewals + 1, arrival, end, positionKept: !changed, priorSequence: before.position, newSequence: after },
    })
    await notify(c.tx, {
      dedupeKey: `waitlist:${e.id}:renewed:${e.renewals + 1}`, kind: 'waitlist.renewed', to: { staffId: e.staffId },
      text: changed
        ? `Your waitlist entry was renewed with new dates until ${expiresAt.toISOString().slice(0, 10)}. Because the dates changed you are now number ${after} in the queue.`
        : `Your waitlist entry was renewed until ${expiresAt.toISOString().slice(0, 10)}. You keep your place: number ${after}.`,
      ref: { type: 'waitlist_entry', id: e.id },
    })
    return ok({ entryId: e.id, expiresAt: expiresAt.toISOString(), positionBefore: before.position, positionAfter: after, positionKept: !changed },
      changed ? `Renewed. The dates changed, so the entry moved to position ${after}` : `Renewed until ${expiresAt.toISOString().slice(0, 10)}; position ${after} kept`)
  })
}
