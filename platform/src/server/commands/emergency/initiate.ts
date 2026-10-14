import { and, eq, inArray, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { bed, site, staffProfile, stay } from '@/server/db/schema'
import { emergencyCheckin, type EligibilityFlags, type EmergencyRoute } from '@/server/db/schema.emergency'
import { audit } from '@/server/audit'
import { authorize, notSelf } from '@/server/command/authorize'
import { runCommand } from '@/server/command/run'
import type { RequestContext } from '@/server/command/context'
import { fail, failure, ok, type Result } from '@/server/command/result'
import { allocateBed } from '@/server/allocation'
import { checkEligibility, recordExceptionUse } from '@/server/eligibility'
import { notify } from '@/server/notify'
import { OCCUPYING_STAY_STATUSES, STAY_TYPES } from '@/domain/enums'
import { addDays } from '@/domain/time'
import { todayInZone } from '@/server/commands/property/shared'
import { deadlineFor, routeFor } from './rules'
import { flagsOf, idSchema, loadTiming, parseInput, primaryRecipient, textSchema } from './shared'

export const input = z.object({
  staffId: idSchema,
  bedId: idSchema,
  /** What happened. Mandatory: it is what the approver reads (SRS section 8). */
  reason: textSchema('Describe what happened'),
  /** Expected length of the stay in days. Left out = no end date yet (the approver and Reception set it). GH-19 (maximum duration) is open. */
  expectedDays: z.number().int().min(1, 'At least one day').max(365, 'At most 365 days').nullish().transform(v => v ?? null),
  // OPEN: the stay type of an emergency stay is not decided; Contract is the prototype's choice and can be corrected by the approver's extension.
  stayType: z.enum(STAY_TYPES).default('contract'),
})
export type InitiateInput = z.input<typeof input>

export interface InitiateOut {
  caseId: string
  stayId: string
  bedId: string
  bedCode: string
  siteId: string
  status: 'pending'
  stayStatus: 'provisional'
  approverRoute: EmergencyRoute
  deadlineAt: string
  /** The rules that would have failed (empty when none). The approver decides; nothing is blocked here (D-66). */
  eligibility: EligibilityFlags
}

/**
 * Emergency check-in (D-66 to D-68): ONE transaction that gives a person a bed at once as a PROVISIONAL stay and opens the
 * approval case. Only holders of the Emergency Check-in capability (policy emergency_checkin.initiate), within their sites.
 *  - the person must be an active employee without an active stay, and cannot be the initiator,
 *  - the bed is locked and allocated through allocateBed() as a stay claim. Eligibility is deferred to the approver, who
 *    sees the rules that would have failed. Readiness still applies: this is a check-in (D-18), so a bed that is not
 *    Available (needs cleaning, inspection) is refused with reason, owner and next action,
 *  - the stay stays Provisional until a human decides; the route is AA for Reception, Policy Approver for an AA (D-68).
 */
export function initiateEmergency(rc: RequestContext, raw: InitiateInput): Promise<Result<InitiateOut>> {
  const parsed = parseInput(input, raw)
  if (!parsed.ok) return Promise.resolve(parsed)
  const i = parsed.data
  return runCommand(rc, async c => {
    const [b] = await c.tx.select({ id: bed.id, siteId: bed.siteId }).from(bed).where(eq(bed.id, i.bedId)).limit(1)
    if (!b) return fail.notFound()
    const denied = authorize(c, 'emergency_checkin.initiate', { siteId: b.siteId })
    if (denied) return denied
    const self = notSelf(c, i.staffId, 'start an emergency check-in')
    if (self) return self

    // Serialise on the person: two initiations for one person queue here and the second sees the first's stay.
    const [p] = await c.tx.select({ id: staffProfile.id, name: staffProfile.fullName, employeeId: staffProfile.employeeId, status: staffProfile.employmentStatus, archivedAt: staffProfile.archivedAt })
      .from(staffProfile).where(eq(staffProfile.id, i.staffId)).limit(1).for('update')
    if (!p) return fail.invalid('That person was not found', { staffId: 'Choose a staff member by employee ID' })
    if (p.archivedAt || p.status !== 'active') {
      return failure('conflict', `${p.name} (${p.employeeId}) is not an active employee`, { owner: 'Accommodation Admin', next: 'Emergency check-in is for active staff. Ask an Accommodation Admin to check the staff record', fields: { staffId: 'Not an active employee' } })
    }
    const [existing] = await c.tx.select({ id: stay.id, status: stay.status }).from(stay)
      .where(and(eq(stay.staffId, p.id), inArray(stay.status, [...OCCUPYING_STAY_STATUSES]), isNull(stay.archivedAt))).limit(1)
    if (existing) {
      return failure('conflict', `${p.name} (${p.employeeId}) already has a stay`, { owner: 'Accommodation Admin', next: 'Open the existing stay. Moving someone is a transfer, not an emergency check-in', detail: { reason: 'has_stay', stayId: existing.id } })
    }

    // Lock the bed. Occupied is "taken", not "not ready": say so.
    const [locked] = await c.tx.select({ id: bed.id, code: bed.code, state: bed.state, roomId: bed.roomId }).from(bed).where(eq(bed.id, b.id)).limit(1).for('update')
    if (locked.state === 'occupied') {
      return failure('conflict', `Bed ${locked.code} is occupied`, { owner: 'Accommodation Admin', next: 'Choose a free bed', detail: { reason: 'bed_taken', bedId: locked.id } })
    }
    const [s] = await c.tx.select({ id: site.id, name: site.name, timeZone: site.timeZone }).from(site).where(eq(site.id, b.siteId)).limit(1)
    const today = todayInZone(c.now, s.timeZone)
    const to = i.expectedDays ? addDays(today, i.expectedDays) : undefined

    const alloc = await allocateBed(c, { bedId: b.id, staffId: p.id, from: today, to, kind: 'stay', requireReady: true, skipEligibility: true })
    if (!alloc.ok) return alloc

    const e = await checkEligibility(c.tx, p.id, b.id, c.now)
    const flags = e ? flagsOf(e) : { ok: true, reasons: [], failed: [], exceptionable: false }

    const [st] = await c.tx.insert(stay).values({
      staffId: p.id, bedId: b.id, claimId: alloc.data.claimId, status: 'provisional', source: 'provisional', stayType: i.stayType, checkedInAt: c.now,
    }).returning({ id: stay.id })
    await c.tx.update(bed).set({ state: 'occupied', stateReason: null, stateSince: c.now }).where(eq(bed.id, b.id))

    const timing = await loadTiming(c.tx)
    const route = routeFor(c.actor.role)
    const deadline = new Date(deadlineFor(c.now.getTime(), timing))
    const [row] = await c.tx.insert(emergencyCheckin).values({
      stayId: st.id, staffId: p.id, bedId: b.id, siteId: b.siteId,
      initiatedBy: c.user.id, initiatedByStaffId: c.actor.staffId ?? c.user.staffId ?? null, initiatedByRole: c.actor.role,
      approverRoute: route, status: 'pending', reason: i.reason, expectedDays: i.expectedDays, eligibilityFlags: flags,
      deadlineAt: deadline, createdAt: c.now, updatedAt: c.now,
    }).returning({ id: emergencyCheckin.id })

    if (e?.exceptionIds.length) await recordExceptionUse(c.tx, e.exceptionIds, { for: 'emergency_checkin', ref: row.id, by: c.user.id })

    await audit(c, {
      action: 'emergency.initiated', entityType: 'emergency_checkin', entityId: row.id, siteId: b.siteId, reason: i.reason,
      before: { bedState: locked.state, staffHadStay: false },
      after: {
        status: 'pending', stayId: st.id, stayStatus: 'provisional', staffId: p.id, bedId: b.id, bedCode: locked.code, approverRoute: route,
        initiatedByRole: c.actor.role, deadlineAt: deadline.toISOString(), claimId: alloc.data.claimId, eligibility: flags,
      },
    })
    await notify(c.tx, {
      dedupeKey: `emergency:${row.id}:initiated`, kind: 'emergency.pending', to: { role: primaryRecipient(route), siteId: b.siteId }, critical: true,
      text: `Emergency check-in needs your decision within ${timing.deadlineHours}h: ${p.name} (${p.employeeId}) is in ${locked.code} at ${s.name} as a provisional stay.${flags.ok ? '' : ` Rules that would have failed: ${flags.reasons.join('; ')}.`}`,
      ref: { type: 'emergency_checkin', id: row.id },
    })

    return ok<InitiateOut>({
      caseId: row.id, stayId: st.id, bedId: b.id, bedCode: locked.code, siteId: b.siteId, status: 'pending', stayStatus: 'provisional',
      approverRoute: route, deadlineAt: deadline.toISOString(), eligibility: flags,
    }, `${p.name} is in ${locked.code} as a provisional stay. ${route === 'AA' ? 'An Accommodation Admin' : 'A Policy Approver'} must decide within ${timing.deadlineHours} hours.`)
  })
}
