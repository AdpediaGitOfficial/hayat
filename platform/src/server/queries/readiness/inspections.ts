/**
 * The inspection queue of a Final Inspection holder: cleaned tasks of their sites whose bed waits in Inspection required.
 * A task the holder cannot inspect themselves (they cleaned it, or they live in that room) is still listed, with the
 * reason, owner and next action, instead of silently disappearing (D-26, D-93).
 */
import { and, asc, eq, inArray } from 'drizzle-orm'
import { bed, building, room, site, staffProfile } from '@/server/db/schema'
import { cleaningTask } from '@/server/db/schema.stage3'
import type { Db } from '@/server/db/client'
import { scopeFilter, type Actor } from '@/server/policy'
import { scopeSql } from '@/server/queries/scope'
import type { ChecklistRecord } from '@/server/commands/readiness/shared'
import { livesInRoomIds } from './own'

export interface InspectionItem {
  taskId: string
  bedId: string
  bedCode: string
  roomName: string
  buildingName: string | null
  siteId: string
  siteName: string
  cleanedByName: string | null
  cleanedAt: string | null
  /** The housekeeper's own words, and the lines as they were answered. */
  notes: string | null
  issue: boolean
  lines: { id: string; label: string; done: boolean }[]
  attachmentCount: number
  /** Set when the viewer may not inspect this one. */
  blocked: { reason: string; owner: string; next: string } | null
}

export async function inspectionQueue(db: Pick<Db, 'select'>, actor: Actor): Promise<InspectionItem[]> {
  const f = scopeFilter(actor, 'housekeeping_readiness.final_inspection')
  if (f.kind === 'none') return []
  const rows = await db.select({
    t: cleaningTask, bedCode: bed.code, roomId: room.id, roomName: room.name, buildingName: building.name, siteId: site.id, siteName: site.name,
  }).from(cleaningTask).innerJoin(bed, eq(bed.id, cleaningTask.bedId)).innerJoin(room, eq(room.id, bed.roomId)).innerJoin(site, eq(site.id, bed.siteId)).leftJoin(building, eq(building.id, room.buildingId))
    .where(and(scopeSql(f, { site: cleaningTask.siteId }), eq(cleaningTask.status, 'cleaned'), eq(bed.state, 'inspection_required')))
    .orderBy(asc(cleaningTask.cleanedAt)).limit(300)
  const cleaners = new Map<string, string>()
  const ids = [...new Set(rows.map(r => r.t.cleanedByStaff).filter((x): x is string => !!x))]
  if (ids.length) for (const p of await db.select({ id: staffProfile.id, n: staffProfile.fullName }).from(staffProfile).where(inArray(staffProfile.id, ids))) cleaners.set(p.id, p.n)
  const living = actor.staffId ? await livesInRoomIds(db, actor.staffId, rows.map(r => r.roomId)) : new Set<string>()
  return rows.map(r => {
    const rec = r.t.checklist as ChecklistRecord | null
    let blocked: InspectionItem['blocked'] = null
    if (actor.staffId && r.t.cleanedByStaff === actor.staffId) blocked = { reason: 'You cleaned this room, so you cannot inspect it', owner: 'Another Final Inspection holder', next: 'Ask a colleague to inspect it (D-26)' }
    else if (living.has(r.roomId)) blocked = { reason: `You live in room ${r.roomName}, so you cannot inspect it`, owner: 'Another Final Inspection holder', next: 'Ask a colleague to inspect it (D-26)' }
    return {
      taskId: r.t.id, bedId: r.t.bedId, bedCode: r.bedCode, roomName: r.roomName, buildingName: r.buildingName, siteId: r.siteId, siteName: r.siteName,
      cleanedByName: r.t.cleanedByStaff ? cleaners.get(r.t.cleanedByStaff) ?? null : null, cleanedAt: r.t.cleanedAt?.toISOString() ?? null,
      notes: rec?.notes ?? null, issue: !!rec?.issue, lines: (rec?.lines ?? []).map(l => ({ id: l.id, label: l.label, done: l.done })), attachmentCount: rec?.attachmentIds?.length ?? 0, blocked,
    }
  })
}
