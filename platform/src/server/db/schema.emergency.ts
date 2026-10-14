/**
 * Tables owned by WP-G (emergency check-in), migration 0080. Foreign keys live in the migration; plain uuid columns here
 * avoid a circular import with ./schema. Register each table in TABLES_EMERGENCY (schema-sync compares them with the database).
 */
import { integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import type { Role } from '@/domain/enums'

const id = () => uuid('id').primaryKey().defaultRandom()
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
const tz = (name: string) => timestamp(name, { withTimezone: true })

export type EmergencyStatus = 'pending' | 'approved' | 'rejected' | 'converted'
export type EmergencyRoute = 'AA' | 'PA'
export type EmergencyVia = 'AA' | 'PolicyApprover' | 'BackupApprover'
/** What eligibility said about this person in this bed (rules that would have failed). */
export interface EligibilityFlags { ok: boolean; reasons: string[]; failed: string[]; exceptionable: boolean }

export const emergencyCheckin = pgTable('emergency_checkin', {
  id: id(),
  stayId: uuid('stay_id').notNull().unique(),
  staffId: uuid('staff_id').notNull(),
  bedId: uuid('bed_id').notNull(),
  siteId: uuid('site_id').notNull(),
  initiatedBy: uuid('initiated_by').notNull(),
  initiatedByStaffId: uuid('initiated_by_staff_id'),
  initiatedByRole: text('initiated_by_role').$type<Role>().notNull(),
  approverRoute: text('approver_route').$type<EmergencyRoute>().notNull(),
  status: text('status').$type<EmergencyStatus>().notNull().default('pending'),
  reason: text('reason').notNull(),
  expectedDays: integer('expected_days'),
  eligibilityFlags: jsonb('eligibility_flags').$type<EligibilityFlags>().notNull().default({ ok: true, reasons: [], failed: [], exceptionable: false }),
  deadlineAt: tz('deadline_at').notNull(),
  reminders: integer('reminders').notNull().default(0),
  lastReminderAt: tz('last_reminder_at'),
  escalation: integer('escalation').notNull().default(0),
  escalatedAt: tz('escalated_at'),
  decidedBy: uuid('decided_by'),
  decidedByRole: text('decided_by_role'),
  decidedVia: text('decided_via').$type<EmergencyVia>(),
  decidedAt: tz('decided_at'),
  decisionNote: text('decision_note'),
  decisionFlags: jsonb('decision_flags').$type<EligibilityFlags>(),
  convertedAt: tz('converted_at'),
  conversionNote: text('conversion_note'),
  archivedAt: tz('archived_at'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const task = pgTable('task', {
  id: id(),
  ownerRole: text('owner_role').$type<Role>().notNull(),
  siteId: uuid('site_id').notNull(),
  title: text('title').notNull(),
  detail: text('detail'),
  refType: text('ref_type'),
  refId: uuid('ref_id'),
  dueAt: tz('due_at'),
  doneAt: tz('done_at'),
  doneBy: uuid('done_by'),
  doneNote: text('done_note'),
  archivedAt: tz('archived_at'),
  createdAt: createdAt(),
})

export const TABLES_EMERGENCY = { emergency_checkin: emergencyCheckin, task } as const
