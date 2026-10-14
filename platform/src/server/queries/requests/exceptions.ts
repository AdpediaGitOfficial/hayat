/**
 * The exception report (docs/APPROVALS.md: gender/grade exceptions, "all uses reported"): every exception a Policy Approver
 * granted, who for, why, on what evidence, and every use. For Policy Approvers (their sites), Super Admins and Auditors.
 */
import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { site, staffProfile, userAccount, accommodationRequest } from '@/server/db/schema'
import { eligibilityException, eligibilityExceptionUse } from '@/server/db/schema.alloc'
import type { Db } from '@/server/db/client'
import { scopeFilter, type Actor, type ScopeFilter } from '@/server/policy'

type Reader = Pick<Db, 'select'>

export interface ExceptionUse { id: string; usedFor: string; usedRef: string | null; at: string }
export interface ExceptionRow {
  id: string
  kind: 'gender' | 'grade'
  staffId: string
  name: string
  employeeId: string
  siteName: string | null
  requestId: string | null
  grantedBy: string | null
  reason: string
  evidence: string
  grantedAt: string
  revoked: boolean
  uses: ExceptionUse[]
}

/** Who may read the report, and for which sites: a Policy Approver (own sites), a Super Admin (all) or an Auditor (own sites). null = nobody. */
export function exceptionReportScope(actor: Actor): ScopeFilter | null {
  const candidates: ScopeFilter[] = []
  if (actor.caps.includes('PolicyApprover')) candidates.push(scopeFilter(actor, 'requests_waitlist.approve_exception'))
  if (actor.role === 'SA' || actor.role === 'Aud') candidates.push(scopeFilter(actor, 'requests_waitlist.view'))
  const live = candidates.filter(f => f.kind !== 'none')
  if (live.length === 0) return null
  if (live.some(f => f.kind === 'all')) return { kind: 'all' }
  const siteIds = [...new Set(live.flatMap(f => (f.kind === 'restricted' ? [...f.siteIds] : [])))]
  return siteIds.length ? { kind: 'restricted', siteIds } : null
}

const granter = alias(userAccount, 'granter')
const granterStaff = alias(staffProfile, 'granter_staff')

export async function listExceptions(db: Reader, actor: Actor, o: { kind?: 'gender' | 'grade'; limit?: number; offset?: number } = {}): Promise<ExceptionRow[] | null> {
  const scope = exceptionReportScope(actor)
  if (!scope) return null
  const limit = Math.min(Math.max(Math.trunc(o.limit ?? 50) || 50, 1), 200)
  // Site of an exception: its own site, else the site of the request it was granted on. Out-of-scope rows are never fetched.
  const siteWhere = scope.kind === 'all' ? undefined : scope.kind === 'restricted'
    ? or(inArray(eligibilityException.siteId, [...scope.siteIds]), and(isNull(eligibilityException.siteId), inArray(accommodationRequest.siteId, [...scope.siteIds]))) : undefined
  const rows = await db.select({
    e: eligibilityException, name: staffProfile.fullName, employeeId: staffProfile.employeeId, siteName: site.name, by: granterStaff.fullName,
  }).from(eligibilityException)
    .innerJoin(staffProfile, eq(staffProfile.id, eligibilityException.staffId))
    .leftJoin(accommodationRequest, eq(accommodationRequest.id, eligibilityException.requestId))
    .leftJoin(site, eq(site.id, eligibilityException.siteId))
    .leftJoin(granter, eq(granter.id, eligibilityException.grantedBy)).leftJoin(granterStaff, eq(granterStaff.id, granter.staffId))
    .where(and(siteWhere, o.kind ? eq(eligibilityException.kind, o.kind) : undefined))
    .orderBy(desc(eligibilityException.createdAt)).limit(limit).offset(Math.max(Math.trunc(o.offset ?? 0) || 0, 0))
  const uses = rows.length ? await db.select().from(eligibilityExceptionUse).where(inArray(eligibilityExceptionUse.exceptionId, rows.map(r => r.e.id))).orderBy(eligibilityExceptionUse.createdAt) : []
  return rows.map(({ e, name, employeeId, siteName, by }) => ({
    id: e.id, kind: e.kind, staffId: e.staffId, name, employeeId, siteName, requestId: e.requestId, grantedBy: by, reason: e.reason, evidence: e.evidence,
    grantedAt: e.createdAt.toISOString(), revoked: e.revokedAt !== null,
    uses: uses.filter(u => u.exceptionId === e.id).map(u => ({ id: u.id, usedFor: u.usedFor, usedRef: u.usedRef, at: u.createdAt.toISOString() })),
  }))
}
