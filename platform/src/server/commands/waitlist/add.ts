import { and, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { accommodationRequest, site, staffProfile } from '@/server/db/schema'
import { waitlistEntry } from '@/server/db/schema.waitlist'
import { audit } from '@/server/audit'
import { authorize } from '@/server/command/authorize'
import { runCommand } from '@/server/command/run'
import type { RequestContext } from '@/server/command/context'
import { fail, ok, type Result } from '@/server/command/result'
import { STAY_TYPES } from '@/domain/enums'
import { DAY } from '@/domain/time'
import { getConfig } from '@/server/config/registry'
import { notify } from '@/server/notify'
import { todayInZone } from '@/server/commands/property/shared'
import { alreadyHoused, queuePosition } from './queue'
import { dateSchema, eligibleInPrinciple, idSchema } from './shared'

export const input = z.object({
  /** Who joins. Omitted = the signed-in person (a resident joining for themselves). */
  staffId: idSchema.optional(),
  /** Alternative to staffId for screens that only know the employee ID (business key). */
  employeeId: z.string().trim().min(1).max(40).optional(),
  siteId: idSchema,
  /** The request this entry stands for. WP-D's approval screen passes it when no bed matches; the request becomes Waitlisted. */
  requestId: idSchema.optional(),
  arrival: dateSchema,
  /** Departure day (D-103). Empty = open-ended (permanent stay). */
  end: dateSchema.nullish().transform(v => v ?? null),
  stayType: z.enum(STAY_TYPES).optional(),
}).refine(i => i.end === null || i.end > i.arrival, { path: ['end'], message: 'The departure day must be after the arrival day' })
export type AddInput = z.input<typeof input>

export interface AddOut { entryId: string; position: number; createdAt: string; expiresAt: string; siteId: string }

/**
 * Puts a person on the waitlist (D-47, AT-009). Residents join for themselves; Reception, the Accommodation Admin and the
 * Super Admin join people on their behalf. One live entry per person. The person must be eligible in principle for the
 * site (same rules as allocation; nothing extra is invented here). The entry lives 15 days (configurable); a linked
 * request becomes Waitlisted.
 */
export function addToWaitlist(rc: RequestContext, i: AddInput): Promise<Result<AddOut>> {
  return runCommand(rc, async c => {
    const p = input.safeParse(i)
    if (!p.success) return fail.invalid('Some fields need attention', Object.fromEntries(p.error.issues.map(x => [x.path.join('.') || '_', x.message])))
    const a = p.data

    let staffId = a.staffId
    if (!staffId && a.employeeId) {
      const [found] = await c.tx.select({ id: staffProfile.id }).from(staffProfile).where(sql`lower(btrim(${staffProfile.employeeId})) = lower(${a.employeeId})`).limit(1)
      staffId = found?.id
      if (!staffId) return fail.notFound()
    }
    staffId ??= c.actor.staffId
    if (!staffId) return fail.invalid('Say who joins the waitlist', { staffId: 'Required' })

    const [s] = await c.tx.select({ id: site.id, name: site.name, tz: site.timeZone, archivedAt: site.archivedAt }).from(site).where(eq(site.id, a.siteId)).limit(1)
    if (!s) return fail.notFound()
    const denied = authorize(c, 'requests_waitlist.submit', { siteId: s.id, ownerStaffId: staffId })
    if (denied) return denied
    const [person] = await c.tx.select().from(staffProfile).where(eq(staffProfile.id, staffId)).limit(1)
    if (!person) return fail.notFound()
    if (s.archivedAt) return fail.conflict(`${s.name} is archived`, 'Super Admin', 'Choose an active site')
    if (person.archivedAt || person.employmentStatus !== 'active') {
      return fail.conflict(`${person.fullName} is not an active employee`, 'Accommodation Admin', 'Only active staff can wait for a bed')
    }

    const today = todayInZone(c.now, s.tz)
    if (a.arrival < today) return fail.invalid('The arrival day is already past', { arrival: `Choose ${today} or later` })

    let stayType = a.stayType ?? (a.end ? 'contract' : 'permanent')
    if (a.requestId) {
      const [r] = await c.tx.select().from(accommodationRequest).where(eq(accommodationRequest.id, a.requestId)).limit(1).for('update')
      if (!r || r.staffId !== staffId || r.siteId !== s.id) return fail.notFound()
      if (r.status !== 'submitted' && r.status !== 'pending_approval') {
        return fail.conflict(`That request is ${r.status.replace(/_/g, ' ')}, so it cannot join the waitlist`, 'Accommodation Admin', 'Only a request still waiting for a decision can be waitlisted')
      }
      stayType = r.stayType
    }

    const [live] = await c.tx.select({ id: waitlistEntry.id }).from(waitlistEntry).where(and(eq(waitlistEntry.staffId, staffId), sql`${waitlistEntry.status} <> 'closed'`)).limit(1)
    if (live) {
      return fail.conflict(`${person.fullName} is already on the waitlist`, 'Accommodation Admin', 'Open the existing entry; renew it if it is about to expire', { reason: 'already_waitlisted', entryId: live.id })
    }
    if (await alreadyHoused(c.tx, staffId)) {
      return fail.conflict(`${person.fullName} already has a reservation or a bed`, 'Accommodation Admin', 'Cancel or move the existing reservation or stay first', { reason: 'already_housed' })
    }

    const fit = await eligibleInPrinciple(c.tx, staffId, s.id, c.now, a.requestId)
    if (!fit.ok) {
      return fail.conflict(`No bed type at ${s.name} is open to ${person.fullName}: ${fit.reasons.join('; ')}`,
        fit.exceptionable ? 'Policy Approver' : 'Accommodation Admin',
        fit.exceptionable ? 'Ask a Policy Approver for a gender or grade exception, then add the person to the waitlist' : fit.noBeds ? 'Add rooms and beds to the site first' : 'This person is not eligible for accommodation at this site',
        { reason: 'not_eligible', failed: fit.reasons, exceptionable: fit.exceptionable })
    }

    const days = await getConfig(c.tx, 'timers.waitlist_entry_days')
    const expiresAt = new Date(c.now.getTime() + days * DAY)
    const onBehalf = c.actor.staffId !== staffId
    const [e] = await c.tx.insert(waitlistEntry).values({
      staffId, siteId: s.id, requestId: a.requestId ?? null, queueTs: c.now, createdAt: c.now, expiresAt,
      arrivalDate: a.arrival, endDate: a.end, stayType, onBehalf, createdBy: c.user.id,
    }).returning({ id: waitlistEntry.id, createdAt: waitlistEntry.createdAt })
    if (a.requestId) await c.tx.update(accommodationRequest).set({ status: 'waitlisted' }).where(eq(accommodationRequest.id, a.requestId))

    const position = (await queuePosition(c.tx, s.id, e.id)) ?? 1
    await audit(c, {
      action: 'waitlist.entry.created', entityType: 'waitlist_entry', entityId: e.id, siteId: s.id,
      after: { staffId, requestId: a.requestId ?? null, arrival: a.arrival, end: a.end, stayType, position, expiresAt: expiresAt.toISOString(), onBehalf },
    })
    await notify(c.tx, {
      dedupeKey: `waitlist:${e.id}:created`, kind: 'waitlist.joined', to: { staffId },
      text: `You are number ${position} on the waitlist for ${s.name}. The entry is valid until ${expiresAt.toISOString().slice(0, 10)}; we will tell you before it ends and when a bed is offered.`,
      ref: { type: 'waitlist_entry', id: e.id },
    })
    return ok({ entryId: e.id, position, createdAt: e.createdAt.toISOString(), expiresAt: expiresAt.toISOString(), siteId: s.id }, `Added to the waitlist at position ${position}`)
  })
}
