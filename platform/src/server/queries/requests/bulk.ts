/** Bulk allocation batches as the screen and the API show them (checkin_checkout.allocate_bulk, site scope). */
import { and, asc, desc, eq, isNull } from 'drizzle-orm'
import { bed, room, site, staffProfile } from '@/server/db/schema'
import { bulkAllocationBatch, bulkAllocationRow, type BulkBatchStatus, type BulkRowOutcome, type BulkRowStatus } from '@/server/db/schema.requests'
import type { Db } from '@/server/db/client'
import type { Actor } from '@/server/policy'
import { scopeFilter } from '@/server/policy'
import { scopeSql } from '../scope'

type Reader = Pick<Db, 'select'>

export interface BulkRowView {
  id: string
  position: number
  staffId: string
  employeeId: string
  name: string
  requestId: string | null
  bedId: string | null
  bedCode: string | null
  roomName: string | null
  arrivalDate: string | null
  endDate: string | null
  stayType: string | null
  outcome: BulkRowOutcome
  message: string
  status: BulkRowStatus
  resultMessage: string | null
  reservationId: string | null
  attempts: number
}
export interface BulkBatchView {
  id: string
  siteId: string
  siteName: string
  status: BulkBatchStatus
  createdAt: string
  confirmedAt: string | null
  rows: BulkRowView[]
  counts: { total: number; ready: number; done: number; failed: number; blocked: number; pending: number }
}

export async function getBulkBatch(db: Reader, actor: Actor, id: string): Promise<BulkBatchView | undefined> {
  const where = scopeSql(scopeFilter(actor, 'checkin_checkout.allocate_bulk'), { site: bulkAllocationBatch.siteId })
  const [b] = await db.select({ b: bulkAllocationBatch, siteName: site.name }).from(bulkAllocationBatch).innerJoin(site, eq(site.id, bulkAllocationBatch.siteId))
    .where(and(eq(bulkAllocationBatch.id, id), isNull(bulkAllocationBatch.archivedAt), where))
  if (!b) return undefined
  const rows = await db.select({
    r: bulkAllocationRow, name: staffProfile.fullName, employeeId: staffProfile.employeeId, bedCode: bed.code, roomName: room.name,
  }).from(bulkAllocationRow)
    .innerJoin(staffProfile, eq(staffProfile.id, bulkAllocationRow.staffId))
    .leftJoin(bed, eq(bed.id, bulkAllocationRow.bedId)).leftJoin(room, eq(room.id, bed.roomId))
    .where(eq(bulkAllocationRow.batchId, id)).orderBy(asc(bulkAllocationRow.position))
  const views: BulkRowView[] = rows.map(({ r, name, employeeId, bedCode, roomName }) => ({
    id: r.id, position: r.position, staffId: r.staffId, employeeId, name, requestId: r.requestId, bedId: r.bedId, bedCode, roomName,
    arrivalDate: r.arrivalDate, endDate: r.endDate, stayType: r.stayType, outcome: r.outcome, message: r.message, status: r.status,
    resultMessage: r.resultMessage, reservationId: r.reservationId, attempts: r.attempts,
  }))
  return {
    id: b.b.id, siteId: b.b.siteId, siteName: b.siteName, status: b.b.status, createdAt: b.b.createdAt.toISOString(), confirmedAt: b.b.confirmedAt?.toISOString() ?? null,
    rows: views,
    counts: {
      total: views.length,
      ready: views.filter(v => v.outcome === 'new').length,
      done: views.filter(v => v.status === 'done').length,
      failed: views.filter(v => v.status === 'failed').length,
      blocked: views.filter(v => v.outcome !== 'new').length,
      pending: views.filter(v => v.outcome === 'new' && v.status === 'pending').length,
    },
  }
}

export async function listBulkBatches(db: Reader, actor: Actor, limit = 20) {
  const where = scopeSql(scopeFilter(actor, 'checkin_checkout.allocate_bulk'), { site: bulkAllocationBatch.siteId })
  return db.select({ id: bulkAllocationBatch.id, status: bulkAllocationBatch.status, createdAt: bulkAllocationBatch.createdAt, siteName: site.name })
    .from(bulkAllocationBatch).innerJoin(site, eq(site.id, bulkAllocationBatch.siteId))
    .where(and(isNull(bulkAllocationBatch.archivedAt), where)).orderBy(desc(bulkAllocationBatch.createdAt)).limit(limit)
}
