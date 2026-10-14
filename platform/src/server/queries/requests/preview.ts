/**
 * Before the request is filed: which sites may this person use, and what do their eligibility and the bed supply look like
 * for their dates? Counts only. It never reveals who is in which bed or anything else about other people.
 */
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { accommodationRequest, site, staffProfile } from '@/server/db/schema'
import type { Db } from '@/server/db/client'
import { suggestBeds } from '@/server/allocation'
import { getConfig } from '@/server/config/registry'
import { can, scopeFilter, type Actor } from '@/server/policy'
import { OPEN_STATUSES } from '@/server/commands/requests/shared'
import { alreadyProvided } from '@/server/commands/requests/rules'

type Reader = Pick<Db, 'select'>

export interface SiteChoice { id: string; code: string; name: string }

/** A Resident may choose any live site; Reception and Accommodation Admins only their own (the rule submitRequest enforces). */
export async function requestableSites(db: Reader, actor: Actor): Promise<SiteChoice[]> {
  const f = scopeFilter(actor, 'requests_waitlist.submit')
  if (f.kind === 'none') return []
  const everySite = f.kind === 'all' || (f.siteIds.length === 0 && actor.role === 'Res')
  const rows = await db.select({ id: site.id, code: site.code, name: site.name }).from(site)
    .where(and(isNull(site.archivedAt), everySite ? undefined : inArray(site.id, f.kind === 'restricted' ? [...f.siteIds] : []))).orderBy(asc(site.name))
  return rows
}

export interface RequestPreview {
  person: { name: string; self: boolean }
  /** Plain-words things the person should know before sending. */
  problems: { tone: 'warning' | 'info' | 'danger'; text: string }[]
  /** Hard stops: filing would be refused. */
  blockers: string[]
  freeBeds: number
  /** Capped at the limit asked for. */
  freeBedsCapped: boolean
}

const CAP = 20

export async function requestPreview(db: Reader, actor: Actor, p: { staffId?: string; employeeId?: string; siteId: string; from: string; to?: string; now: Date }): Promise<RequestPreview | undefined> {
  let staffId = p.staffId ?? actor.staffId
  if (p.employeeId && actor.role !== 'Res') {
    // An officer files for somebody else by employee ID; the form asks what the picture looks like before sending.
    const [hit] = await db.select({ id: staffProfile.id }).from(staffProfile).where(sql`lower(btrim(${staffProfile.employeeId})) = ${p.employeeId.trim().toLowerCase()}`)
    if (!hit) return { person: { name: '', self: false }, problems: [], blockers: ['No staff member has that employee ID.'], freeBeds: 0, freeBedsCapped: false }
    staffId = hit.id
  }
  if (!staffId) return undefined
  const self = staffId === actor.staffId
  if (!can(actor, 'requests_waitlist.submit', { siteId: p.siteId, ownerStaffId: staffId })) return undefined
  if (actor.role === 'Res' && !self) return undefined
  const [s] = await db.select().from(staffProfile).where(eq(staffProfile.id, staffId))
  if (!s) return undefined
  const you = self ? 'You are' : `${s.fullName} is`
  const problems: RequestPreview['problems'] = []
  const blockers: string[] = []

  if (s.employmentStatus !== 'active' || s.archivedAt) blockers.push(`${you} not an active employee, so a request cannot be filed. Ask the Accommodation Admin.`)
  const open = await db.select({ id: accommodationRequest.id }).from(accommodationRequest).where(and(eq(accommodationRequest.staffId, staffId), inArray(accommodationRequest.status, [...OPEN_STATUSES]))).limit(1)
  if (open.length) blockers.push(`${self ? 'You already have' : `${s.fullName} already has`} an open request. Cancel it first if you want to file a new one.`)
  const housed = await alreadyProvided(db, staffId, s.fullName)
  if (housed) blockers.push(housed.reason + (housed.next ? `. ${housed.next}` : ''))

  // Reception does not see grade or gender (staff directory minimum): the picture must not reveal them either.
  const sees = self || can(actor, 'staff_directory.view', { siteId: p.siteId })
  const minGrade = await getConfig(db, 'eligibility.min_grade', p.siteId)
  if (sees && minGrade > 0 && (s.grade ?? -1) < minGrade) {
    problems.push({ tone: 'warning', text: `This site asks for grade ${minGrade} or above${s.grade === null ? ' and no grade is recorded' : ''}. You can still send the request: a Policy Approver can allow an exception.` })
  }
  if (sees && !s.gender && (await getConfig(db, 'eligibility.gender_strict'))) {
    problems.push({ tone: 'info', text: 'No gender is recorded, so male-only and female-only rooms cannot be offered until it is. Ask the Accommodation Admin to update the record.' })
  }

  const beds = await suggestBeds(db, { staffId, siteId: p.siteId, from: p.from, to: p.to, limit: CAP, now: p.now })
  if (!sees) problems.push({ tone: 'info', text: 'The Accommodation Admin checks eligibility when they choose the bed.' })
  if (beds.length === 0) {
    problems.push({ tone: 'warning', text: 'No bed that suits these dates looks free right now. You can still send the request; the admin may offer the waitlist (valid for 15 days).' })
  }
  return { person: { name: s.fullName, self }, problems, blockers, freeBeds: beds.length, freeBedsCapped: beds.length >= CAP }
}
