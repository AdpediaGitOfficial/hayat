/** Typed definitions for tables added by WP-B: staff and CSV import (migrations in db/migrations). Register each table in TABLES_STAFF. */
import { integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

const tz = (name: string) => timestamp(name, { withTimezone: true })

export type ImportClassification = 'new' | 'duplicate' | 'invalid'
export type ImportOutcome = 'created' | 'rejected'
export type ImportPolicy = 'save_valid' | 'all_or_nothing'

/* References to user_account / staff_profile are plain uuid columns here: the foreign keys live in the migration,
   and importing the tables from ./schema would make the two files import each other. */
export const importBatch = pgTable('import_batch', {
  id: uuid('id').primaryKey().defaultRandom(),
  kind: text('kind').$type<'staff'>().notNull().default('staff'),
  status: text('status').$type<'previewed' | 'confirmed'>().notNull().default('previewed'),
  fileName: text('file_name'),
  createdBy: uuid('created_by').notNull(),
  totalRows: integer('total_rows').notNull(),
  newRows: integer('new_rows').notNull(),
  duplicateRows: integer('duplicate_rows').notNull(),
  invalidRows: integer('invalid_rows').notNull(),
  warningRows: integer('warning_rows').notNull(),
  ignoredColumns: text('ignored_columns').array().notNull().default([]),
  policy: text('policy').$type<ImportPolicy>(),
  createdCount: integer('created_count'),
  rejectedCount: integer('rejected_count'),
  confirmedBy: uuid('confirmed_by'),
  confirmedAt: tz('confirmed_at'),
  archivedAt: tz('archived_at'),
  createdAt: tz('created_at').notNull().defaultNow(),
  updatedAt: tz('updated_at').notNull().defaultNow(),
})

export const importRow = pgTable('import_row', {
  id: uuid('id').primaryKey().defaultRandom(),
  batchId: uuid('batch_id').notNull(),
  rowNo: integer('row_no').notNull(),
  raw: jsonb('raw').$type<Record<string, string>>().notNull(),
  data: jsonb('data').$type<Record<string, unknown>>(),
  employeeKey: text('employee_key'),
  classification: text('classification').$type<ImportClassification>().notNull(),
  reasons: text('reasons').array().notNull().default([]),
  warnings: text('warnings').array().notNull().default([]),
  outcome: text('outcome').$type<ImportOutcome>(),
  outcomeReason: text('outcome_reason'),
  staffId: uuid('staff_id'),
  archivedAt: tz('archived_at'),
  createdAt: tz('created_at').notNull().defaultNow(),
})

export const TABLES_STAFF = { import_batch: importBatch, import_row: importRow } as const
