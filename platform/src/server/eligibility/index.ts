/**
 * Eligibility against the database: loads the person, the bed's room and site, the configured rules and any
 * Policy Approver exceptions that apply, and runs the pure rules (src/domain/eligibility.ts).
 */
import { and, eq, gte, isNull, or } from 'drizzle-orm'
import { bed, room, site, staffProfile } from '@/server/db/schema'
import { eligibilityException, eligibilityExceptionUse } from '@/server/db/schema.alloc'
import type { Db } from '@/server/db/client'
import type { Tx } from '@/server/command/context'
import { getConfig } from '@/server/config/registry'
import { evaluateEligibility, type EligibilityResult } from '@/domain/eligibility'
import { DEFAULT_CALENDAR, type Calendar } from '@/domain/approvals'

type Reader = Pick<Db, 'select'>

export interface EligibilityCheck extends EligibilityResult {
  /** Exceptions that were needed and exist; record their use when the allocation commits (recordExceptionUse). */
  exceptionIds: string[]
}

/** The site's working week and holidays (G-01 is open: Saturday and Sunday off, no holidays, until configured). */
export async function loadCalendar(q: Reader, siteId?: string): Promise<Calendar> {
  return {
    weekendDays: await getConfig(q, 'calendar.weekend_days', siteId) ?? DEFAULT_CALENDAR.weekendDays,
    holidays: await getConfig(q, 'calendar.holidays', siteId) ?? [],
  }
}

export async function checkEligibility(q: Reader, staffId: string, bedId: string, now: Date, o: { requestId?: string; transferId?: string } = {}): Promise<EligibilityCheck | undefined> {
  const [row] = await q.select({
    employmentStatus: staffProfile.employmentStatus, gender: staffProfile.gender, grade: staffProfile.grade,
    roomName: room.name, genderPolicy: room.genderPolicy, siteId: bed.siteId, siteName: site.name,
  }).from(bed)
    .innerJoin(room, eq(room.id, bed.roomId))
    .innerJoin(site, eq(site.id, bed.siteId))
    .innerJoin(staffProfile, eq(staffProfile.id, staffId))
    .where(eq(bed.id, bedId)).limit(1)
  if (!row) return undefined

  const today = now.toISOString().slice(0, 10)
  const ex = await q.select({ id: eligibilityException.id, kind: eligibilityException.kind }).from(eligibilityException).where(and(
    eq(eligibilityException.staffId, staffId), isNull(eligibilityException.revokedAt),
    or(isNull(eligibilityException.validUntil), gte(eligibilityException.validUntil, today)),
    or(isNull(eligibilityException.siteId), eq(eligibilityException.siteId, row.siteId)),
    o.requestId ? or(isNull(eligibilityException.requestId), eq(eligibilityException.requestId, o.requestId)) : isNull(eligibilityException.requestId),
    o.transferId ? or(isNull(eligibilityException.transferRequestId), eq(eligibilityException.transferRequestId, o.transferId)) : isNull(eligibilityException.transferRequestId),
  ))

  const result = evaluateEligibility({
    staff: { employmentStatus: row.employmentStatus, gender: row.gender, grade: row.grade },
    room: { name: row.roomName, genderPolicy: row.genderPolicy },
    site: { name: row.siteName, minGrade: await getConfig(q, 'eligibility.min_grade', row.siteId) },
    genderStrict: await getConfig(q, 'eligibility.gender_strict'),
    exceptions: new Set(ex.map(e => e.kind)),
  })
  const used = new Set(result.exceptionsUsed)
  return { ...result, exceptionIds: ex.filter(e => used.has(e.kind)).map(e => e.id) }
}

/** Every use of an exception is recorded, so the Policy Approver's "all uses reported" duty (APPROVALS.md) can be met. */
export async function recordExceptionUse(tx: Tx, exceptionIds: string[], used: { for: string; ref?: string; by?: string }) {
  if (exceptionIds.length === 0) return
  await tx.insert(eligibilityExceptionUse).values(exceptionIds.map(exceptionId => ({
    exceptionId, usedFor: used.for, usedRef: used.ref ?? null, usedBy: used.by ?? null,
  })))
}
