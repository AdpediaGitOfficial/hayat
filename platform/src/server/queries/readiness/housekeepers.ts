/**
 * Who can be given a cleaning task: employees still employed, with a usable login and an ACTIVE Housekeeping grant (same
 * evaluation as sign-in). For the assign picker of Reception and the Super Admin. When a task is named, anyone who lives in that
 * room is listed as not assignable, with the reason (D-26).
 */
import { and, count, eq, inArray, isNull, gt, lte, or } from 'drizzle-orm'
import { bed, capabilityGrant, staffProfile, userAccount } from '@/server/db/schema'
import { cleaningTask } from '@/server/db/schema.stage3'
import type { Db } from '@/server/db/client'
import { can, decide, type Actor } from '@/server/policy'
import { livesInRoomIds } from './own'

export interface HousekeeperOption { staffId: string; employeeId: string; name: string; openTasks: number; blocked: string | null }

export async function listHousekeepers(db: Pick<Db, 'select' | 'selectDistinct'>, actor: Actor, now: Date, o: { taskId?: string } = {}): Promise<HousekeeperOption[] | undefined> {
  if (!decide(actor, 'housekeeping_readiness.assign').allowed) return undefined
  const rows = await db.selectDistinct({ staffId: staffProfile.id, employeeId: staffProfile.employeeId, name: staffProfile.fullName })
    .from(capabilityGrant).innerJoin(userAccount, eq(userAccount.id, capabilityGrant.userId)).innerJoin(staffProfile, eq(staffProfile.id, userAccount.staffId))
    .where(and(
      eq(capabilityGrant.capability, 'Housekeeping'), eq(capabilityGrant.status, 'active'), isNull(capabilityGrant.revokedAt),
      lte(capabilityGrant.startsAt, now), or(isNull(capabilityGrant.expiresAt), gt(capabilityGrant.expiresAt, now)),
      inArray(userAccount.status, ['active', 'locked']), isNull(userAccount.revokedAt), eq(staffProfile.employmentStatus, 'active'), isNull(staffProfile.archivedAt),
    )).limit(500)
  if (rows.length === 0) return []
  const loads = await db.select({ staffId: cleaningTask.assignedToStaff, n: count() }).from(cleaningTask)
    .where(and(eq(cleaningTask.status, 'open'), inArray(cleaningTask.assignedToStaff, rows.map(r => r.staffId)))).groupBy(cleaningTask.assignedToStaff)
  const load = new Map(loads.map(l => [l.staffId, l.n]))
  let roomId: string | undefined
  if (o.taskId) {
    const [t] = await db.select({ roomId: bed.roomId, siteId: cleaningTask.siteId }).from(cleaningTask).innerJoin(bed, eq(bed.id, cleaningTask.bedId)).where(eq(cleaningTask.id, o.taskId)).limit(1)
    if (!t || !can(actor, 'housekeeping_readiness.assign', { siteId: t.siteId })) return undefined // out of scope reads as not found
    roomId = t.roomId
  }
  const out: HousekeeperOption[] = []
  for (const r of rows) {
    const lives = roomId ? (await livesInRoomIds(db, r.staffId, [roomId])).has(roomId) : false
    out.push({ staffId: r.staffId, employeeId: r.employeeId, name: r.name, openTasks: load.get(r.staffId) ?? 0, blocked: lives ? 'Lives in this room' : null })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}
