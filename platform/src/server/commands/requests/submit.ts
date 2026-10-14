import { and, eq, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import { accommodationRequest, staffProfile } from '@/server/db/schema'
import { audit } from '@/server/audit'
import { runCommand } from '@/server/command/run'
import type { RequestContext } from '@/server/command/context'
import { fail, failure, ok, type Result } from '@/server/command/result'
import { getConfig } from '@/server/config/registry'
import { notify } from '@/server/notify'
import { isUrgent } from '@/domain/approvals'
import { fmtDate } from '@/domain/time'
import { dateSchema, idSchema, noteSchema, notifyRequester, OPEN_STATUSES, snapRequest, stayTypeSchema } from './shared'
import { alreadyProvided, checkSubmitAccess, validateFields } from './rules'

export const input = z.object({
  /** Who the request is for. Leave both out to request for yourself. */
  staffId: idSchema.optional(),
  employeeId: z.string().trim().min(1, 'Required').max(40).optional(),
  siteId: idSchema,
  arrivalDate: dateSchema,
  /** The departure day (D-103). Empty is allowed only for permanent stays. */
  endDate: dateSchema.nullish().transform(v => v ?? null),
  stayType: stayTypeSchema,
  note: noteSchema,
})
export type SubmitRequestInput = z.infer<typeof input>

export interface SubmitRequestOut { requestId: string; status: 'submitted'; onBehalf: boolean; urgent: boolean }

/**
 * Files an accommodation request (D-43: a request is not a reservation). A Resident files for themselves; Reception and
 * Accommodation Admins file on behalf of anyone at their own sites. One open request per person: the person's staff row is
 * locked first, so two simultaneous submissions cannot both pass the check.
 */
export function submitRequest(rc: RequestContext, i: SubmitRequestInput): Promise<Result<SubmitRequestOut>> {
  return runCommand(rc, async c => {
    // 1. Who is it for?
    let targetId = i.staffId
    if (!targetId && i.employeeId) {
      const [byKey] = await c.tx.select({ id: staffProfile.id }).from(staffProfile).where(sql`lower(btrim(${staffProfile.employeeId})) = ${i.employeeId.trim().toLowerCase()}`)
      targetId = byKey?.id
      if (!targetId && c.actor.role !== 'Res') return fail.invalid('No staff member has that employee ID', { employeeId: 'Check the employee ID' })
    }
    if (!i.staffId && !i.employeeId) targetId = c.actor.staffId
    if (c.actor.role === 'Res' && targetId !== c.actor.staffId) return fail.forbidden('request a bed for someone else', 'Reception or an Accommodation Admin')
    if (!targetId) return fail.invalid('Your login is not linked to a staff record', { staffId: 'Ask an administrator to link your account' })

    // 2. May the actor do it, here?
    const denied = checkSubmitAccess(c, i.siteId, targetId)
    if (denied) return denied

    // 3. Lock the person so one open request per person holds under concurrency.
    const [staff] = await c.tx.select({ id: staffProfile.id, name: staffProfile.fullName, employeeId: staffProfile.employeeId, status: staffProfile.employmentStatus, archivedAt: staffProfile.archivedAt })
      .from(staffProfile).where(eq(staffProfile.id, targetId)).for('update')
    if (!staff) return fail.invalid('That staff member does not exist', { staffId: 'Choose someone from the directory' })
    if (staff.status !== 'active' || staff.archivedAt) {
      return failure('conflict', `${staff.name} is not an active employee, so no new request can be filed`, { owner: 'Accommodation Admin', next: 'Rehire goes through the authorised review before accommodation can be requested', detail: { reason: 'not_active' } })
    }

    // 4. Dates and site.
    const v = await validateFields(c, { siteId: i.siteId, arrivalDate: i.arrivalDate, endDate: i.endDate, stayType: i.stayType })
    if ('ok' in v) return v

    // 5. Already asked, housed, reserved or queued?
    const [open] = await c.tx.select({ id: accommodationRequest.id, status: accommodationRequest.status }).from(accommodationRequest)
      .where(and(eq(accommodationRequest.staffId, staff.id), inArray(accommodationRequest.status, [...OPEN_STATUSES]))).limit(1)
    if (open) {
      return failure('conflict', `${staff.name} already has an open request (${open.status.replace(/_/g, ' ')})`, {
        owner: 'Accommodation Admin', next: 'Open the existing request, or cancel it before filing a new one', detail: { reason: 'open_request', requestId: open.id, status: open.status },
      })
    }
    const housed = await alreadyProvided(c.tx, staff.id, staff.name)
    if (housed) return housed

    // 6. Write.
    const onBehalf = staff.id !== c.actor.staffId
    const [row] = await c.tx.insert(accommodationRequest).values({
      staffId: staff.id, siteId: i.siteId, submittedBy: c.user.id, onBehalf, arrivalDate: i.arrivalDate, endDate: i.endDate,
      stayType: i.stayType, note: i.note, status: 'submitted',
    }).returning()

    const urgent = isUrgent(row.arrivalDate, c.now.getTime(), await getConfig(c.tx, 'timers.routine_sla_business_days'))
    await audit(c, { action: 'requests.request.submitted', entityType: 'request', entityId: row.id, siteId: row.siteId, after: { ...snapRequest(row), onBehalf, urgent } })
    await notify(c.tx, {
      dedupeKey: `request:${row.id}:submitted`, kind: 'request.submitted', to: { role: 'AA', siteId: row.siteId }, ref: { type: 'request', id: row.id },
      text: `${urgent ? 'Urgent: ' : ''}New accommodation request from ${staff.name} (${staff.employeeId}), arriving ${fmtDate(row.arrivalDate)}${row.endDate ? ` until ${fmtDate(row.endDate)}` : ', open-ended'}`,
    })
    if (onBehalf) {
      await notifyRequester(c.tx, row, `request:${row.id}:submitted`, 'request.submitted', `A bed request was filed for you for ${fmtDate(row.arrivalDate)}. An Accommodation Admin will choose a bed.`, { except: c.actor.staffId })
    }
    return ok({ requestId: row.id, status: 'submitted' as const, onBehalf, urgent }, onBehalf ? `Request filed for ${staff.name}. An Accommodation Admin will choose a bed.` : 'Request submitted. An Accommodation Admin will choose a bed.')
  })
}
