/** Relocation and checkout tasks (D-69), visible to whoever may view or approve emergency check-ins at the task's site. */
import { and, asc, eq, isNull, or, sql } from 'drizzle-orm'
import { bed, staffProfile, stay } from '@/server/db/schema'
import { emergencyCheckin, task } from '@/server/db/schema.emergency'
import type { Db } from '@/server/db/client'
import { scopeFilter, type Actor } from '@/server/policy'
import { scopeSql } from '@/server/queries/scope'

export interface TaskView {
  id: string
  ownerRole: string
  siteId: string
  title: string
  detail: string | null
  dueAt: string | null
  overdue: boolean
  doneAt: string | null
  doneNote: string | null
  caseId: string | null
  stayId: string | null
  stayStatus: string | null
  staffName: string | null
  bedCode: string | null
}

export async function listTasks(db: Pick<Db, 'select'>, actor: Actor, now: Date, o: { open?: boolean; limit?: number } = {}): Promise<TaskView[]> {
  const parts = (['emergency_checkin.view', 'emergency_checkin.approve'] as const).map(a => scopeSql(scopeFilter(actor, a), { site: task.siteId }))
  const scope = parts.some(p => p === undefined) ? undefined : or(...parts)
  const rows = await db.select({
    t: task, caseId: emergencyCheckin.id, stayId: stay.id, stayStatus: stay.status, staffName: staffProfile.fullName, bedCode: bed.code,
  }).from(task)
    .leftJoin(emergencyCheckin, and(eq(task.refType, 'emergency_checkin'), eq(task.refId, emergencyCheckin.id)))
    .leftJoin(stay, eq(stay.id, emergencyCheckin.stayId))
    .leftJoin(staffProfile, eq(staffProfile.id, emergencyCheckin.staffId))
    .leftJoin(bed, eq(bed.id, emergencyCheckin.bedId))
    .where(and(scope, isNull(task.archivedAt), o.open === false ? sql`${task.doneAt} is not null` : o.open ? isNull(task.doneAt) : undefined))
    .orderBy(asc(task.doneAt), asc(task.dueAt)).limit(Math.min(o.limit ?? 100, 200))
  return rows.map(r => ({
    id: r.t.id, ownerRole: r.t.ownerRole, siteId: r.t.siteId, title: r.t.title, detail: r.t.detail, dueAt: r.t.dueAt?.toISOString() ?? null,
    overdue: !r.t.doneAt && !!r.t.dueAt && r.t.dueAt.getTime() < now.getTime(), doneAt: r.t.doneAt?.toISOString() ?? null, doneNote: r.t.doneNote,
    caseId: r.caseId, stayId: r.stayId, stayStatus: r.stayStatus, staffName: r.staffName, bedCode: r.bedCode,
  }))
}
