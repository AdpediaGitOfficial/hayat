/**
 * Tables owned by WP-H (Mark as Left, clearance, bulk exit), migration 0100. Foreign keys live in the migration; plain uuid
 * columns here avoid a circular import with ./schema. Register each table in TABLES_EXIT (schema-sync compares them with the database).
 */
import { bigint, boolean, date, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

const id = () => uuid('id').primaryKey().defaultRandom()
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
const tz = (name: string) => timestamp(name, { withTimezone: true })

export type ClearanceStatus = 'open' | 'in_progress' | 'pending_items' | 'cleared'
export type ClearanceOwner = 'Reception' | 'Maintenance' | 'AA'
export type ClearanceItemStatus = 'open' | 'done' | 'waived' | 'outstanding'
export type ClearanceEventKind = 'opened' | 'item_added' | 'item_done' | 'item_reopened' | 'item_outstanding' | 'item_waived' | 'item_synced' | 'closed'
export type ExitBatchStatus = 'previewed' | 'confirmed' | 'partial' | 'discarded'
export type ExitRowOutcome = 'will_mark' | 'already_left' | 'not_found' | 'blocked'
export type ExitRowStatus = 'pending' | 'done' | 'failed' | 'skipped'

export const clearanceCase = pgTable('clearance_case', {
  id: id(),
  staffId: uuid('staff_id').notNull(),
  stayId: uuid('stay_id'),
  siteId: uuid('site_id'),
  triggerKind: text('trigger_kind').$type<'exit'>().notNull().default('exit'),
  effectiveDate: date('effective_date').notNull(),
  reason: text('reason').notNull(),
  status: text('status').$type<ClearanceStatus>().notNull().default('open'),
  openedBy: uuid('opened_by').notNull(),
  openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
  dueDate: date('due_date').notNull(),
  clearedBy: uuid('cleared_by'),
  clearedAt: tz('cleared_at'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const clearanceItem = pgTable('clearance_item', {
  id: id(),
  caseId: uuid('case_id').notNull(),
  kind: text('kind').$type<'checklist' | 'handover'>().notNull(),
  checklistKey: text('checklist_key'),
  handoverItemId: uuid('handover_item_id'),
  label: text('label').notNull(),
  mandatory: boolean('mandatory').notNull(),
  owner: text('owner').$type<ClearanceOwner>().notNull(),
  position: integer('position').notNull(),
  status: text('status').$type<ClearanceItemStatus>().notNull().default('open'),
  doneBy: uuid('done_by'),
  doneAt: tz('done_at'),
  onBehalfOfStaffId: uuid('on_behalf_of_staff_id'),
  note: text('note'),
  waivedBy: uuid('waived_by'),
  waivedAt: tz('waived_at'),
  waiverReason: text('waiver_reason'),
  waiverEvidence: text('waiver_evidence'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const clearanceEvent = pgTable('clearance_event', {
  id: id(),
  seq: bigint('seq', { mode: 'number' }).generatedAlwaysAsIdentity(),
  caseId: uuid('case_id').notNull(),
  itemId: uuid('item_id'),
  kind: text('kind').$type<ClearanceEventKind>().notNull(),
  actorUserId: uuid('actor_user_id'),
  onBehalfOfStaffId: uuid('on_behalf_of_staff_id'),
  note: text('note'),
  createdAt: createdAt(),
})

export const exitBulkBatch = pgTable('exit_bulk_batch', {
  id: id(),
  createdBy: uuid('created_by').notNull(),
  effectiveDate: date('effective_date').notNull(),
  reason: text('reason').notNull(),
  status: text('status').$type<ExitBatchStatus>().notNull().default('previewed'),
  confirmedBy: uuid('confirmed_by'),
  confirmedAt: tz('confirmed_at'),
  archivedAt: tz('archived_at'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const exitBulkRow = pgTable('exit_bulk_row', {
  id: id(),
  batchId: uuid('batch_id').notNull(),
  position: integer('position').notNull(),
  employeeId: text('employee_id').notNull(),
  staffId: uuid('staff_id'),
  outcome: text('outcome').$type<ExitRowOutcome>().notNull(),
  message: text('message').notNull().default(''),
  status: text('status').$type<ExitRowStatus>().notNull().default('pending'),
  resultMessage: text('result_message'),
  caseId: uuid('case_id'),
  attempts: integer('attempts').notNull().default(0),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const TABLES_EXIT = {
  clearance_case: clearanceCase,
  clearance_item: clearanceItem,
  clearance_event: clearanceEvent,
  exit_bulk_batch: exitBulkBatch,
  exit_bulk_row: exitBulkRow,
} as const
