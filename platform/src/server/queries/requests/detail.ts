/**
 * One request as its page shows it. Scope is requests_waitlist.view (site for staff, own for a Resident); anything else is
 * "not found". What each viewer may DO is computed here from the same rules the commands enforce, so a button is never
 * offered that the API would refuse (the API still checks).
 */
import { and, asc, desc, eq, inArray } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { accommodationRequest, auditEvent, bed, bedClaim, reservation, room, site, staffProfile, userAccount } from '@/server/db/schema'
import { eligibilityException, eligibilityExceptionUse } from '@/server/db/schema.alloc'
import { requestExceptionAsk } from '@/server/db/schema.requests'
import type { Db } from '@/server/db/client'
import type { RequestContext } from '@/server/command/context'
import { can } from '@/server/policy'
import { getConfig } from '@/server/config/registry'
import { loadCalendar } from '@/server/eligibility'
import { approvalClock, isUrgent, type ApprovalClock } from '@/domain/approvals'
import { REQUEST_EVENT } from '@/domain/requests'
import type { RequestStatus, ReservationStatus, StayTypeDb } from '@/domain/enums'

type Reader = Pick<Db, 'select'>
type Viewer = Pick<RequestContext, 'actor' | 'user'>

export interface TimelineEntry { at: string; label: string; actor: string | null; reason: string | null }
export interface RequestDetail {
  id: string
  status: RequestStatus
  urgent: boolean
  onBehalf: boolean
  person: { staffId: string; name: string; employeeId: string; department: string | null; gender: string | null; grade: number | null; employmentStatus: string }
  /** Gender and grade are shown to those who decide eligibility, not to Reception or Managers. */
  profileVisible: boolean
  site: { id: string; name: string }
  arrivalDate: string
  endDate: string | null
  stayType: StayTypeDb
  note: string | null
  submittedBy: string | null
  createdAt: string
  decidedAt: string | null
  decisionReason: string | null
  reservation: { id: string; status: ReservationStatus; bedId: string; bedLabel: string; from: string; to: string | null } | null
  /** Staff only: the exception route (asks, grants and every use). */
  exception: null | {
    asks: { id: string; status: string; kinds: string[]; reason: string; askedAt: string; decidedAt: string | null; decisionReason: string | null }[]
    granted: { id: string; kind: string; reason: string; evidence: string; at: string; uses: number }[]
  }
  clock: ApprovalClock | null
  can: {
    approve: boolean
    askException: boolean
    grantException: boolean
    edit: boolean
    resubmit: boolean
    cancel: boolean
    /** When an action is not available to this viewer because of who they are: the reason (D-26). */
    whyNot: string | null
  }
  timeline: TimelineEntry[]
}

const submitter = alias(userAccount, 'submitter')
const actorUser = alias(userAccount, 'actor_user')
const actorStaff = alias(staffProfile, 'actor_staff')

export async function getRequestDetail(db: Reader, v: Viewer, id: string, now: Date): Promise<RequestDetail | undefined> {
  const [row] = await db.select({
    r: accommodationRequest, name: staffProfile.fullName, employeeId: staffProfile.employeeId, department: staffProfile.department, gender: staffProfile.gender,
    grade: staffProfile.grade, employment: staffProfile.employmentStatus, siteName: site.name,
  }).from(accommodationRequest)
    .innerJoin(staffProfile, eq(staffProfile.id, accommodationRequest.staffId))
    .innerJoin(site, eq(site.id, accommodationRequest.siteId))
    .where(eq(accommodationRequest.id, id))
  if (!row) return undefined
  const r = row.r
  // Scope: out-of-scope looks exactly like a missing record (AT-002).
  if (!can(v.actor, 'requests_waitlist.view', { siteId: r.siteId, ownerStaffId: r.staffId })) return undefined

  const isRequester = (v.actor.staffId !== undefined && r.staffId === v.actor.staffId) || r.submittedBy === v.user.id
  const canApproveRole = can(v.actor, 'requests_waitlist.approve', { siteId: r.siteId })
  const canExceptionRole = can(v.actor, 'requests_waitlist.approve_exception', { siteId: r.siteId })
  const profileVisible = can(v.actor, 'staff_directory.view', { siteId: r.siteId }) || canExceptionRole

  const sodBlocked = (v.actor.staffId !== undefined && r.staffId === v.actor.staffId) || (r.onBehalf && r.submittedBy === v.user.id)
  const submittedByRow = r.submittedBy
    ? (await db.select({ name: staffProfile.fullName }).from(submitter).leftJoin(staffProfile, eq(staffProfile.id, submitter.staffId)).where(eq(submitter.id, r.submittedBy)))[0]
    : undefined

  const [rv] = await db.select({ id: reservation.id, status: reservation.status, bedId: reservation.bedId, code: bed.code, roomName: room.name, siteName: site.name })
    .from(reservation).innerJoin(bed, eq(bed.id, reservation.bedId)).innerJoin(room, eq(room.id, bed.roomId)).innerJoin(site, eq(site.id, bed.siteId))
    .where(eq(reservation.requestId, id)).orderBy(desc(reservation.createdAt)).limit(1)
  let resv: RequestDetail['reservation'] = null
  if (rv) {
    const [claim] = await db.select({ period: bedClaim.period }).from(reservation).innerJoin(bedClaim, eq(bedClaim.id, reservation.claimId)).where(eq(reservation.id, rv.id))
    const m = /^[\[(]([^,]*),([^)\]]*)[)\]]$/.exec(claim?.period ?? '')
    resv = { id: rv.id, status: rv.status, bedId: rv.bedId, bedLabel: `Bed ${rv.code}, Room ${rv.roomName}, ${rv.siteName}`, from: m?.[1] || r.arrivalDate, to: m?.[2] || null }
  }

  // Exceptions are for the people who deal with them, never the resident.
  const exceptionVisible = canApproveRole || canExceptionRole || (can(v.actor, 'audit_log.view', { siteId: r.siteId })) || v.actor.role === 'Aud'
  let exception: RequestDetail['exception'] = null
  if (exceptionVisible) {
    const asks = await db.select().from(requestExceptionAsk).where(eq(requestExceptionAsk.requestId, id)).orderBy(asc(requestExceptionAsk.createdAt))
    const granted = await db.select().from(eligibilityException).where(eq(eligibilityException.requestId, id)).orderBy(asc(eligibilityException.createdAt))
    const uses = granted.length ? await db.select({ exceptionId: eligibilityExceptionUse.exceptionId }).from(eligibilityExceptionUse).where(inArray(eligibilityExceptionUse.exceptionId, granted.map(g => g.id))) : []
    exception = {
      asks: asks.map(a => ({ id: a.id, status: a.status, kinds: a.kinds, reason: a.reason, askedAt: a.createdAt.toISOString(), decidedAt: a.decidedAt?.toISOString() ?? null, decisionReason: a.decisionReason })),
      granted: granted.map(g => ({ id: g.id, kind: g.kind, reason: g.reason, evidence: g.evidence, at: g.createdAt.toISOString(), uses: uses.filter(u => u.exceptionId === g.id).length })),
    }
  }

  // Timeline from the audit log. A resident sees what happened to their request, not who the staff were or the exception route.
  const events = await db.select({
    action: auditEvent.action, at: auditEvent.createdAt, reason: auditEvent.reason, actorName: actorStaff.fullName, actorRole: auditEvent.actorRole,
  }).from(auditEvent)
    .leftJoin(actorUser, eq(actorUser.id, auditEvent.actorUserId)).leftJoin(actorStaff, eq(actorStaff.id, actorUser.staffId))
    .where(and(eq(auditEvent.entityType, 'request'), eq(auditEvent.entityId, id))).orderBy(asc(auditEvent.seq))
  const timeline: TimelineEntry[] = []
  for (const e of events) {
    const def = REQUEST_EVENT[e.action]
    if (!def) continue
    if (def.private && !exceptionVisible) continue
    timeline.push({ at: e.at.toISOString(), label: def.label, actor: exceptionVisible ? (e.actorName ?? e.actorRole) : null, reason: e.reason })
  }

  const open = r.status === 'submitted' || r.status === 'pending_approval' || r.status === 'changes_requested'
  const sla = await getConfig(db, 'timers.routine_sla_business_days')
  const clock = (canApproveRole || canExceptionRole) && (r.status === 'submitted' || r.status === 'pending_approval')
    ? approvalClock(r.updatedAt.getTime(), now.getTime(), sla, await loadCalendar(db, r.siteId)) : null
  const grantBlocked = (v.actor.staffId !== undefined && r.staffId === v.actor.staffId) || r.submittedBy === v.user.id
  return {
    id: r.id, status: r.status, urgent: r.status === 'submitted' && isUrgent(r.arrivalDate, now.getTime(), sla), onBehalf: r.onBehalf,
    person: { staffId: r.staffId, name: row.name, employeeId: row.employeeId, department: row.department, gender: profileVisible ? row.gender : null, grade: profileVisible ? row.grade : null, employmentStatus: row.employment },
    profileVisible,
    site: { id: r.siteId, name: row.siteName },
    arrivalDate: r.arrivalDate, endDate: r.endDate, stayType: r.stayType, note: r.note,
    submittedBy: submittedByRow?.name ?? null,
    createdAt: r.createdAt.toISOString(), decidedAt: r.decidedAt?.toISOString() ?? null, decisionReason: r.decisionReason,
    reservation: resv, exception, clock,
    can: {
      approve: canApproveRole && r.status === 'submitted' && !sodBlocked,
      askException: canApproveRole && r.status === 'submitted' && !sodBlocked,
      grantException: canExceptionRole && (r.status === 'pending_approval' || r.status === 'submitted') && !grantBlocked,
      edit: isRequester && r.status === 'changes_requested',
      resubmit: isRequester && r.status === 'changes_requested',
      cancel: open && (isRequester || canApproveRole),
      whyNot: sodBlocked && (canApproveRole)
        ? (v.actor.staffId === r.staffId ? 'This request is about you, so a different Accommodation Admin decides it (separation of duties, D-26).' : 'You filed this request on someone\'s behalf, so a different Accommodation Admin decides it (separation of duties, D-26).')
        : grantBlocked && canExceptionRole ? 'This request is about you or was filed by you, so a different Policy Approver decides the exception (D-26).' : null,
    },
    timeline,
  }
}
