/**
 * Emergency check-in reads. A case is visible to people who may view or approve emergency check-ins at its site, and to the
 * person who started it (initiating alone shows nothing but your own cases). The row restriction is part of the WHERE, so an
 * out-of-scope case is never fetched. Each row also says whether THIS viewer may decide it and, if not, why (reason, owner, next).
 */
import { and, desc, eq, or, sql, type SQL } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { bed, room, site, staffProfile, stay, userAccount } from '@/server/db/schema'
import { emergencyCheckin, type EligibilityFlags, type EmergencyRoute, type EmergencyStatus, type EmergencyVia } from '@/server/db/schema.emergency'
import type { Db } from '@/server/db/client'
import { scopeFilter, type Actor } from '@/server/policy'
import { scopeSql } from '@/server/queries/scope'
import { loadTiming } from '@/server/commands/emergency/shared'
import { LEVEL_LABEL, primaryLabel, reminderDueAt, standing, type EmergencyTiming } from '@/server/commands/emergency/rules'
import type { Role } from '@/domain/enums'

type Reader = Pick<Db, 'select'>
export interface Viewer { actor: Actor; userId: string }

export interface CaseView {
  id: string
  status: EmergencyStatus
  siteId: string
  siteName: string
  siteCode: string
  staffId: string
  employeeId: string
  staffName: string
  bedId: string
  bedCode: string
  roomName: string
  stayId: string
  stayStatus: string
  initiatedByName: string | null
  initiatedByRole: Role
  approverRoute: EmergencyRoute
  /** Who holds the decision right now (role or capability, never a name: GH-07 is open). */
  currentOwner: string
  reason: string
  expectedDays: number | null
  eligibility: EligibilityFlags
  createdAt: string
  deadlineAt: string
  reminders: number
  lastReminderAt: string | null
  /** When the next reminder is due (pending only). */
  nextReminderAt: string | null
  escalation: number
  escalatedAt: string | null
  decidedAt: string | null
  decidedByName: string | null
  decidedVia: EmergencyVia | null
  decisionNote: string | null
  decisionFlags: EligibilityFlags | null
  conversionNote: string | null
  /** This viewer's standing on the case. */
  me: { canDecide: true; via: EmergencyVia } | { canDecide: false; kind: 'initiator' | 'subject' | 'no_action' | 'not_on_route'; why: string; owner: string; next: string }
}

export function visibleCases(actor: Actor, userId: string): SQL | undefined {
  const parts = (['emergency_checkin.view', 'emergency_checkin.approve'] as const).map(a => scopeSql(scopeFilter(actor, a), { site: emergencyCheckin.siteId }))
  if (parts.some(p => p === undefined)) return undefined // an action that covers every site
  return or(...parts, eq(emergencyCheckin.initiatedBy, userId))
}

const ini = alias(userAccount, 'ini'), iniStaff = alias(staffProfile, 'ini_staff')
const dec = alias(userAccount, 'dec'), decStaff = alias(staffProfile, 'dec_staff')

function select(q: Reader) {
  return q.select({
    c: emergencyCheckin, siteName: site.name, siteCode: site.code, employeeId: staffProfile.employeeId, staffName: staffProfile.fullName,
    bedCode: bed.code, roomName: room.name, stayStatus: stay.status, initiatedByName: iniStaff.fullName, decidedByName: decStaff.fullName,
  }).from(emergencyCheckin)
    .innerJoin(site, eq(site.id, emergencyCheckin.siteId))
    .innerJoin(staffProfile, eq(staffProfile.id, emergencyCheckin.staffId))
    .innerJoin(bed, eq(bed.id, emergencyCheckin.bedId))
    .innerJoin(room, eq(room.id, bed.roomId))
    .innerJoin(stay, eq(stay.id, emergencyCheckin.stayId))
    .leftJoin(ini, eq(ini.id, emergencyCheckin.initiatedBy))
    .leftJoin(iniStaff, eq(iniStaff.id, ini.staffId))
    .leftJoin(dec, eq(dec.id, emergencyCheckin.decidedBy))
    .leftJoin(decStaff, eq(decStaff.id, dec.staffId))
}
type Row = Awaited<ReturnType<typeof select>>[number]

function toView(r: Row, v: Viewer, t: EmergencyTiming): CaseView {
  const k = r.c
  const s = standing({ actor: v.actor, userId: v.userId }, {
    route: k.approverRoute, escalation: k.escalation, siteId: k.siteId, initiatedBy: k.initiatedBy, initiatedByStaffId: k.initiatedByStaffId, subjectStaffId: k.staffId,
  })
  const pending = k.status === 'pending'
  return {
    id: k.id, status: k.status, siteId: k.siteId, siteName: r.siteName, siteCode: r.siteCode, staffId: k.staffId, employeeId: r.employeeId, staffName: r.staffName,
    bedId: k.bedId, bedCode: r.bedCode, roomName: r.roomName, stayId: k.stayId, stayStatus: r.stayStatus,
    initiatedByName: r.initiatedByName, initiatedByRole: k.initiatedByRole, approverRoute: k.approverRoute,
    currentOwner: k.escalation >= 1 ? LEVEL_LABEL[Math.min(k.escalation, 2)] : primaryLabel(k.approverRoute),
    reason: k.reason, expectedDays: k.expectedDays, eligibility: k.eligibilityFlags,
    createdAt: k.createdAt.toISOString(), deadlineAt: k.deadlineAt.toISOString(), reminders: k.reminders, lastReminderAt: k.lastReminderAt?.toISOString() ?? null,
    nextReminderAt: pending ? new Date(reminderDueAt(k.deadlineAt.getTime(), k.reminders + 1, t)).toISOString() : null,
    escalation: k.escalation, escalatedAt: k.escalatedAt?.toISOString() ?? null,
    decidedAt: k.decidedAt?.toISOString() ?? null, decidedByName: r.decidedByName, decidedVia: k.decidedVia, decisionNote: k.decisionNote, decisionFlags: k.decisionFlags,
    conversionNote: k.conversionNote,
    me: !pending
      ? { canDecide: false, kind: 'not_on_route', why: `Already ${k.status === 'converted' ? 'closed by Mark as Left' : k.status}`, owner: 'Accommodation Admin', next: 'Open the stay to see where it stands' }
      : s.ok ? { canDecide: true, via: s.via } : { canDecide: false, kind: s.kind, why: s.why, owner: s.owner, next: s.next },
  }
}

export interface CaseFilter { status?: 'pending' | 'decided' | 'all'; siteId?: string; limit?: number }

export async function listCases(db: Reader, v: Viewer, f: CaseFilter = {}): Promise<{ items: CaseView[]; timing: EmergencyTiming }> {
  const status = f.status ?? 'all'
  const where = and(
    visibleCases(v.actor, v.userId),
    status === 'pending' ? eq(emergencyCheckin.status, 'pending') : status === 'decided' ? sql`${emergencyCheckin.status} <> 'pending'` : undefined,
    f.siteId ? eq(emergencyCheckin.siteId, f.siteId) : undefined,
  )
  const rows = await select(db).where(where).orderBy(desc(emergencyCheckin.createdAt)).limit(Math.min(f.limit ?? 100, 200))
  const timing = await loadTiming(db)
  return { items: rows.map(r => toView(r, v, timing)), timing }
}

/** One case, or undefined when it does not exist or the viewer may not see it (the same answer: 404). */
export async function getCase(db: Reader, v: Viewer, id: string): Promise<{ item: CaseView; timing: EmergencyTiming } | undefined> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return undefined
  const [row] = await select(db).where(and(eq(emergencyCheckin.id, id), visibleCases(v.actor, v.userId))).limit(1)
  if (!row) return undefined
  const timing = await loadTiming(db)
  return { item: toView(row, v, timing), timing }
}
