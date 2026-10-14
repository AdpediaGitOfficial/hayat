/** Tables owned by WP-D (requests, approvals, bulk allocation; migration 0050). Register each table in TABLES_REQUESTS (schema-sync compares them with the database).
 *  Foreign keys live in the migration; plain uuid columns here avoid a circular import with ./schema. */
import { date, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import type { StayTypeDb } from '@/domain/enums'

const id = () => uuid('id').primaryKey().defaultRandom()
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
const tz = (name: string) => timestamp(name, { withTimezone: true })

export type ExceptionKind = 'gender' | 'grade'
export type ExceptionAskStatus = 'asked' | 'granted' | 'declined' | 'withdrawn'

export const requestExceptionAsk = pgTable('request_exception_ask', {
  id: id(),
  requestId: uuid('request_id').notNull(),
  siteId: uuid('site_id').notNull(),
  askedBy: uuid('asked_by').notNull(),
  kinds: text('kinds').array().$type<ExceptionKind[]>().notNull().default([]),
  bedId: uuid('bed_id'),
  reason: text('reason').notNull(),
  status: text('status').$type<ExceptionAskStatus>().notNull().default('asked'),
  decidedBy: uuid('decided_by'),
  decidedAt: tz('decided_at'),
  decisionReason: text('decision_reason'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export type BulkBatchStatus = 'previewed' | 'confirmed' | 'partial' | 'discarded'
export type BulkRowOutcome = 'new' | 'conflict' | 'not_eligible' | 'no_request'
export type BulkRowStatus = 'pending' | 'done' | 'failed' | 'skipped'

export const bulkAllocationBatch = pgTable('bulk_allocation_batch', {
  id: id(),
  siteId: uuid('site_id').notNull(),
  createdBy: uuid('created_by').notNull(),
  status: text('status').$type<BulkBatchStatus>().notNull().default('previewed'),
  confirmedBy: uuid('confirmed_by'),
  confirmedAt: tz('confirmed_at'),
  archivedAt: tz('archived_at'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const bulkAllocationRow = pgTable('bulk_allocation_row', {
  id: id(),
  batchId: uuid('batch_id').notNull(),
  position: integer('position').notNull(),
  staffId: uuid('staff_id').notNull(),
  requestId: uuid('request_id'),
  bedId: uuid('bed_id'),
  arrivalDate: date('arrival_date'),
  endDate: date('end_date'),
  stayType: text('stay_type').$type<StayTypeDb>(),
  outcome: text('outcome').$type<BulkRowOutcome>().notNull(),
  message: text('message').notNull().default(''),
  status: text('status').$type<BulkRowStatus>().notNull().default('pending'),
  resultMessage: text('result_message'),
  reservationId: uuid('reservation_id'),
  attempts: integer('attempts').notNull().default(0),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const TABLES_REQUESTS = {
  request_exception_ask: requestExceptionAsk,
  bulk_allocation_batch: bulkAllocationBatch,
  bulk_allocation_row: bulkAllocationRow,
} as const
