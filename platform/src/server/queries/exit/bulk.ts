/** A stored bulk-exit preview or result, as the screen and the API show it. Only the person who made the batch sees it. */
import { and, asc, eq, isNull } from 'drizzle-orm'
import { exitBulkBatch, exitBulkRow, type ExitBatchStatus, type ExitRowOutcome, type ExitRowStatus } from '@/server/db/schema.exit'
import type { Db } from '@/server/db/client'
import type { Actor } from '@/server/policy'

export interface ExitBatchRowView {
  id: string
  position: number
  employeeId: string
  staffId: string | null
  outcome: ExitRowOutcome
  message: string
  status: ExitRowStatus
  resultMessage: string | null
  caseId: string | null
  attempts: number
}
export interface ExitBatchView {
  id: string
  status: ExitBatchStatus
  effectiveDate: string
  reason: string
  createdAt: string
  confirmedAt: string | null
  rows: ExitBatchRowView[]
  counts: { willMark: number; alreadyLeft: number; notFound: number; blocked: number; done: number; failed: number }
}

export async function getExitBatch(q: Pick<Db, 'select'>, _actor: Actor, userId: string, id: string): Promise<ExitBatchView | undefined> {
  const [b] = await q.select().from(exitBulkBatch).where(and(eq(exitBulkBatch.id, id), isNull(exitBulkBatch.archivedAt))).limit(1)
  if (!b || b.createdBy !== userId) return undefined
  const rows = await q.select().from(exitBulkRow).where(eq(exitBulkRow.batchId, b.id)).orderBy(asc(exitBulkRow.position))
  const count = (f: (r: (typeof rows)[number]) => boolean) => rows.filter(f).length
  return {
    id: b.id, status: b.status, effectiveDate: b.effectiveDate, reason: b.reason, createdAt: b.createdAt.toISOString(), confirmedAt: b.confirmedAt?.toISOString() ?? null,
    rows: rows.map(r => ({ id: r.id, position: r.position, employeeId: r.employeeId, staffId: r.staffId, outcome: r.outcome, message: r.message, status: r.status, resultMessage: r.resultMessage, caseId: r.caseId, attempts: r.attempts })),
    counts: {
      willMark: count(r => r.outcome === 'will_mark'), alreadyLeft: count(r => r.outcome === 'already_left'), notFound: count(r => r.outcome === 'not_found'),
      blocked: count(r => r.outcome === 'blocked'), done: count(r => r.status === 'done'), failed: count(r => r.status === 'failed'),
    },
  }
}
