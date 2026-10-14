/**
 * A housekeeper's rooms: the open cleaning tasks assigned to THEM, nothing else (job scope). No names of residents, no other
 * rooms, no board. Includes the checklist to answer and, for a redo, what the inspector said was wrong.
 */
import { and, asc, desc, eq, isNotNull } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { bed, building, room, site } from '@/server/db/schema'
import { cleaningTask } from '@/server/db/schema.stage3'
import type { Db } from '@/server/db/client'
import { scopeFilter, type Actor } from '@/server/policy'
import { scopeSql } from '@/server/queries/scope'
import { getConfig } from '@/server/config/registry'
import { livesInRoomIds } from './own'

export interface ChecklistLine { id: string; label: string; required: boolean }
export interface MyRoom {
  taskId: string
  bedId: string
  bedCode: string
  roomName: string
  buildingName: string | null
  siteId: string
  siteName: string
  reason: string
  assignedAt: string | null
  /** Why the last inspection of this bed failed, when this task is the redo. */
  redoNote: string | null
  /** The housekeeper lives in this room: they cannot clean it (D-26). */
  blocked: { reason: string; owner: string; next: string } | null
}
export interface MyRooms { checklist: ChecklistLine[]; rooms: MyRoom[] }

export async function myRooms(db: Pick<Db, 'select'>, actor: Actor): Promise<MyRooms | undefined> {
  const f = scopeFilter(actor, 'housekeeping_readiness.clean')
  if (f.kind === 'none' || !actor.staffId) return undefined
  const failed = alias(cleaningTask, 'failed_task')
  const rows = await db.select({
    taskId: cleaningTask.id, bedId: bed.id, bedCode: bed.code, roomId: room.id, roomName: room.name, buildingName: building.name, siteId: site.id, siteName: site.name,
    reason: cleaningTask.reason, assignedAt: cleaningTask.assignedAt, createdAt: cleaningTask.createdAt,
  }).from(cleaningTask).innerJoin(bed, eq(bed.id, cleaningTask.bedId)).innerJoin(room, eq(room.id, bed.roomId)).innerJoin(site, eq(site.id, bed.siteId)).leftJoin(building, eq(building.id, room.buildingId))
    // Job scope only: the assignee column. The site column is deliberately left out, so a site-wide grant can never widen "my rooms".
    .where(and(scopeSql(f, { assignee: cleaningTask.assignedToStaff }), eq(cleaningTask.status, 'open'), eq(bed.state, 'needs_cleaning')))
    .orderBy(asc(cleaningTask.assignedAt)).limit(200)
  const living = await livesInRoomIds(db, actor.staffId, rows.map(r => r.roomId))
  const out: MyRoom[] = []
  for (const r of rows) {
    const [prev] = await db.select({ note: failed.inspectionNote }).from(failed)
      .where(and(eq(failed.bedId, r.bedId), eq(failed.status, 'failed'), isNotNull(failed.inspectionNote))).orderBy(desc(failed.inspectedAt)).limit(1)
    out.push({
      taskId: r.taskId, bedId: r.bedId, bedCode: r.bedCode, roomName: r.roomName, buildingName: r.buildingName, siteId: r.siteId, siteName: r.siteName,
      reason: r.reason, assignedAt: r.assignedAt?.toISOString() ?? null, redoNote: r.reason === 'Failed inspection' ? prev?.note ?? null : null,
      blocked: living.has(r.roomId) ? { reason: `You live in room ${r.roomName}, so you cannot clean it`, owner: 'Reception', next: 'Ask Reception to give this room to another housekeeper' } : null,
    })
  }
  const lines = (await getConfig(db, 'readiness.cleaning_checklist')).map(l => ({ id: l.id, label: l.label, required: l.required }))
  return { checklist: lines, rooms: out }
}
