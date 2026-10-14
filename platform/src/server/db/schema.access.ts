/**
 * Typed definitions for tables added by WP-C: access, configuration and audit (migrations 0030-0039 in db/migrations).
 * Register each table in TABLES_ACCESS. The SQL is the source of truth; tests/db/schema-sync.test.ts compares the two.
 * (No .references() here: this file is imported by schema.ts, so it cannot import the tables it would point at.)
 */
import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import type { Role, ScopeKind } from '@/domain/enums'

const tz = (name: string) => timestamp(name, { withTimezone: true })

export type RoleChangeStatus = 'pending' | 'approved' | 'rejected' | 'cancelled'

/** A role/scope change waiting for (or carrying) a second Super Admin's decision (D-27). */
export const roleChangeRequest = pgTable('role_change_request', {
  id: uuid('id').primaryKey().defaultRandom(),
  targetUserId: uuid('target_user_id').notNull(),
  kind: text('kind').$type<'add' | 'remove'>().notNull(),
  role: text('role').$type<Role>().notNull(),
  scopeKind: text('scope_kind').$type<ScopeKind>().notNull(),
  siteId: uuid('site_id'),
  buildingId: uuid('building_id'),
  assignmentId: uuid('assignment_id'),
  resultingAssignmentId: uuid('resulting_assignment_id'),
  reason: text('reason').notNull(),
  status: text('status').$type<RoleChangeStatus>().notNull().default('pending'),
  makerId: uuid('maker_id').notNull(),
  checkerId: uuid('checker_id'),
  decidedAt: tz('decided_at'),
  decisionNote: text('decision_note'),
  archivedAt: tz('archived_at'),
  createdAt: tz('created_at').notNull().defaultNow(),
  updatedAt: tz('updated_at').notNull().defaultNow(),
})

/** The site an account was created for; with its site-scoped role assignments it decides which Accommodation Admins manage it. */
export const accountSite = pgTable('account_site', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull(),
  siteId: uuid('site_id').notNull(),
  createdBy: uuid('created_by'),
  archivedAt: tz('archived_at'),
  createdAt: tz('created_at').notNull().defaultNow(),
})

export const TABLES_ACCESS = {
  role_change_request: roleChangeRequest,
  account_site: accountSite,
} as const
