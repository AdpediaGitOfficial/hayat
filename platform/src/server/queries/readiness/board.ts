/**
 * The readiness board: every bed of the actor's sites that is not ready, with its task, who has it, how long it has waited, who owns
 * the next step and what that step is, in words (D-93). Scoped in SQL through scopeSql, never fetch-then-filter.
 *
 * A housekeeper (job scope only) has no site scope here and gets `undefined` (the route answers 403): they see their own rooms
 * through `myRooms`, never the board. The Manager and the Auditor get the summary only, with no names and no rows (PERMISSIONS: Summary).
 */
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { bed, bedClaim, building, room, site, staffProfile } from '@/server/db/schema'
import { cleaningTask } from '@/server/db/schema.stage3'
import type { Db } from '@/server/db/client'
import { decide, scopeFilter, type Actor } from '@/server/policy'
import { scopeSql } from '@/server/queries/scope'
import { getConfig } from '@/server/config/registry'
import { explainBed, READINESS_STATES, type ReadinessState } from './text'

export interface BoardTask {
  id: string
  status: 'open' | 'cleaned'
  reason: string
  assigneeStaffId: string | null
  assigneeName: string | null
  assignedAt: string | null
  cleanedByName: string | null
  cleanedAt: string | null
  createdAt: string
  issue: boolean
}
export interface BoardRow {
  bedId: string
  bedCode: string
  roomId: string
  roomName: string
  buildingName: string | null
  siteId: string
  siteName: string
  state: ReadinessState
  stateReason: string | null
  since: string
  ageHours: number
  /** The earliest booked arrival on this bed (reservation or held offer), if any: how urgent it is. */
  needBy: string | null
  task: BoardTask | null
  label: string
  owner: string
  next: string
  overSla: boolean
}
export interface BoardSummary {
  needsCleaning: number
  unassigned: number
  awaitingInspection: number
  blocked: number
  underMaintenance: number
  overSla: number
  /** Hours the longest-waiting bed has waited in its state. */
  oldestHours: number
}
export interface Board { summary: BoardSummary; slaHours: number; rows: BoardRow[] | null }

const HOUR = 3_600_000
const SUMMARY_ONLY = new Set(['Mgr', 'Aud'])

export async function readinessBoard(db: Pick<Db, 'select'>, actor: Actor, now: Date, o: { siteId?: string } = {}): Promise<Board | undefined> {
  const d = decide(actor, 'housekeeping_readiness.view')
  if (!d.allowed) return undefined
  const f = scopeFilter(actor, 'housekeeping_readiness.view')
  // Only a job-scoped grant (a housekeeper): not the board.
  if (f.kind === 'none' || (f.kind === 'restricted' && f.siteIds.length === 0)) return d.via === 'role' ? { summary: emptySummary(), slaHours: 0, rows: [] } : undefined
  const slaHours = await getConfig(db, 'readiness.cleaning_sla_hours')
  const where = and(
    scopeSql(f, { site: bed.siteId }), inArray(bed.state, [...READINESS_STATES]), isNull(bed.archivedAt),
    o.siteId ? eq(bed.siteId, o.siteId) : undefined,
  )
  const beds = await db.select({
    bedId: bed.id, bedCode: bed.code, state: bed.state, stateReason: bed.stateReason, since: bed.stateSince,
    roomId: room.id, roomName: room.name, buildingName: building.name, siteId: site.id, siteName: site.name,
  }).from(bed).innerJoin(room, eq(room.id, bed.roomId)).innerJoin(site, eq(site.id, bed.siteId)).leftJoin(building, eq(building.id, room.buildingId))
    .where(where).orderBy(asc(site.name), asc(room.name), asc(bed.code)).limit(1000)

  const ids = beds.map(b => b.bedId)
  const tasks = ids.length === 0 ? [] : await db.select().from(cleaningTask).where(and(inArray(cleaningTask.bedId, ids), inArray(cleaningTask.status, ['open', 'cleaned'])))
  const people = new Map<string, string>()
  const staffIds = [...new Set(tasks.flatMap(t => [t.assignedToStaff, t.cleanedByStaff]).filter((x): x is string => !!x))]
  if (staffIds.length) for (const p of await db.select({ id: staffProfile.id, n: staffProfile.fullName }).from(staffProfile).where(inArray(staffProfile.id, staffIds))) people.set(p.id, p.n)
  const arrivals = new Map<string, string>()
  if (ids.length) {
    const rows = await db.select({ bedId: bedClaim.bedId, from: sql<string>`min(lower(${bedClaim.period}))::text` }).from(bedClaim)
      .where(and(inArray(bedClaim.bedId, ids), isNull(bedClaim.releasedAt), inArray(bedClaim.kind, ['reservation', 'offer_hold']))).groupBy(bedClaim.bedId)
    for (const r of rows) arrivals.set(r.bedId, r.from)
  }
  const byBed = new Map(tasks.map(t => [t.bedId, t]))

  const rows: BoardRow[] = beds.map(b => {
    const t = byBed.get(b.bedId)
    const task: BoardTask | null = t && (t.status === 'open' || t.status === 'cleaned') ? {
      id: t.id, status: t.status, reason: t.reason, assigneeStaffId: t.assignedToStaff, assigneeName: t.assignedToStaff ? people.get(t.assignedToStaff) ?? null : null,
      assignedAt: t.assignedAt?.toISOString() ?? null, cleanedByName: t.cleanedByStaff ? people.get(t.cleanedByStaff) ?? null : null, cleanedAt: t.cleanedAt?.toISOString() ?? null,
      createdAt: t.createdAt.toISOString(), issue: !!(t.checklist as { issue?: boolean } | null)?.issue,
    } : null
    const state = b.state as ReadinessState
    const ex = explainBed(state, task && { status: task.status, assigneeName: task.assigneeName }, b.stateReason)
    // The wait that matters: since the task stage began (opened, or cleaned), else since the bed changed state.
    const clockStart = task ? Date.parse(task.status === 'cleaned' ? task.cleanedAt ?? task.createdAt : task.createdAt) : b.since.getTime()
    const overSla = (state === 'needs_cleaning' || state === 'inspection_required') && now.getTime() - clockStart >= slaHours * HOUR
    return {
      bedId: b.bedId, bedCode: b.bedCode, roomId: b.roomId, roomName: b.roomName, buildingName: b.buildingName, siteId: b.siteId, siteName: b.siteName,
      state, stateReason: b.stateReason, since: b.since.toISOString(), ageHours: Math.max(0, Math.floor((now.getTime() - b.since.getTime()) / HOUR)),
      needBy: arrivals.get(b.bedId) ?? null, task, ...ex, overSla,
    }
  })
  // Most urgent first within the page: an arrival is booked, then the longest wait.
  rows.sort((a, b) => (a.needBy ? 0 : 1) - (b.needBy ? 0 : 1) || (a.needBy ?? '').localeCompare(b.needBy ?? '') || b.ageHours - a.ageHours)

  const summary: BoardSummary = {
    needsCleaning: rows.filter(r => r.state === 'needs_cleaning').length,
    unassigned: rows.filter(r => r.state === 'needs_cleaning' && r.task?.status === 'open' && !r.task.assigneeStaffId).length,
    awaitingInspection: rows.filter(r => r.state === 'inspection_required').length,
    blocked: rows.filter(r => r.state === 'blocked').length,
    underMaintenance: rows.filter(r => r.state === 'under_maintenance').length,
    overSla: rows.filter(r => r.overSla).length,
    oldestHours: rows.reduce((m, r) => Math.max(m, r.ageHours), 0),
  }
  return { summary, slaHours, rows: SUMMARY_ONLY.has(actor.role) ? null : rows }
}

function emptySummary(): BoardSummary {
  return { needsCleaning: 0, unassigned: 0, awaitingInspection: 0, blocked: 0, underMaintenance: 0, overSla: 0, oldestHours: 0 }
}
