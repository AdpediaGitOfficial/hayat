/** Stage 2 core tables (migration 0040): notifications, sweep log, eligibility exceptions.
 *  Foreign keys live in the migration; plain uuid columns here avoid a circular import with ./schema. */
import { boolean, date, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import type { Capability, Role } from '@/domain/enums'

const id = () => uuid('id').primaryKey().defaultRandom()
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
const tz = (name: string) => timestamp(name, { withTimezone: true })

export const notification = pgTable('notification', {
  id: id(),
  dedupeKey: text('dedupe_key').notNull(),
  kind: text('kind').notNull(),
  toStaffId: uuid('to_staff_id'),
  toRole: text('to_role').$type<Role | Capability>(),
  siteId: uuid('site_id'),
  text: text('text').notNull(),
  refType: text('ref_type'),
  refId: uuid('ref_id'),
  critical: boolean('critical').notNull().default(false),
  emailStatus: text('email_status').$type<'pending' | 'sent' | 'failed' | 'not_applicable'>().notNull().default('pending'),
  emailAttempts: integer('email_attempts').notNull().default(0),
  readAt: tz('read_at'),
  createdAt: createdAt(),
})

export const sweepRun = pgTable('sweep_run', {
  id: id(),
  name: text('name').notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: tz('finished_at'),
  ok: boolean('ok'),
  summary: jsonb('summary'),
  error: text('error'),
  createdAt: createdAt(),
})

export const eligibilityException = pgTable('eligibility_exception', {
  id: id(),
  staffId: uuid('staff_id').notNull(),
  kind: text('kind').$type<'gender' | 'grade'>().notNull(),
  siteId: uuid('site_id'),
  requestId: uuid('request_id'),
  grantedBy: uuid('granted_by').notNull(),
  reason: text('reason').notNull(),
  evidence: text('evidence').notNull(),
  validUntil: date('valid_until'),
  revokedAt: tz('revoked_at'),
  createdAt: createdAt(),
})

export const eligibilityExceptionUse = pgTable('eligibility_exception_use', {
  id: id(),
  exceptionId: uuid('exception_id').notNull(),
  usedFor: text('used_for').notNull(),
  usedRef: uuid('used_ref'),
  usedBy: uuid('used_by'),
  createdAt: createdAt(),
})

export const TABLES_ALLOC = {
  notification, sweep_run: sweepRun, eligibility_exception: eligibilityException, eligibility_exception_use: eligibilityExceptionUse,
} as const
