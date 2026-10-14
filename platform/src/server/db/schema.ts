/**
 * Typed table definitions for queries. The SQL migrations in db/migrations are the source of truth for the
 * schema (constraints, triggers, grants); this file only describes the columns. tests/db/schema-sync.test.ts
 * compares it with the migrated database, so a column added to one and not the other fails CI.
 */
import { bigint, boolean, customType, date, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { TABLES_PROPERTY } from './schema.property'
import { TABLES_STAFF } from './schema.staff'
import { TABLES_ACCESS } from './schema.access'
import { TABLES_ALLOC } from './schema.alloc'
import { TABLES_REQUESTS } from './schema.requests'
import { TABLES_WAITLIST } from './schema.waitlist'
import { TABLES_STAYS } from './schema.stays'
import { TABLES_EMERGENCY } from './schema.emergency'
import type {
  BedStateDb, Capability, ClaimKind, GrantStatus, OfferStatus, RequestStatus, ReservationStatus, Role, ScopeKind,
  StayStatus, StayTypeDb, WaitlistStatus,
} from '@/domain/enums'

/** '[2026-10-14,2026-10-21)' as Postgres prints it. Build values with claimPeriod() from domain/claims. */
const daterange = customType<{ data: string }>({ dataType: () => 'daterange' })
const inet = customType<{ data: string }>({ dataType: () => 'inet' })

const id = () => uuid('id').primaryKey().defaultRandom()
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
const archivedAt = () => timestamp('archived_at', { withTimezone: true })
const tz = (name: string) => timestamp(name, { withTimezone: true })

/* ---------------- property ---------------- */
export const site = pgTable('site', {
  id: id(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  kind: text('kind').$type<'villa' | 'apartment' | 'other'>().notNull().default('other'),
  timeZone: text('time_zone').notNull().default('UTC'),
  archivedAt: archivedAt(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const building = pgTable('building', {
  id: id(),
  siteId: uuid('site_id').notNull().references(() => site.id),
  code: text('code').notNull(),
  name: text('name').notNull(),
  archivedAt: archivedAt(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const room = pgTable('room', {
  id: id(),
  siteId: uuid('site_id').notNull().references(() => site.id),
  buildingId: uuid('building_id'),
  floor: text('floor'),
  unit: text('unit'),
  name: text('name').notNull(),
  genderPolicy: text('gender_policy').$type<'any' | 'male' | 'female'>().notNull().default('any'),
  archivedAt: archivedAt(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const bed = pgTable('bed', {
  id: id(),
  siteId: uuid('site_id').notNull(),
  roomId: uuid('room_id').notNull(),
  code: text('code').notNull(),
  state: text('state').$type<BedStateDb>().notNull().default('available'),
  stateReason: text('state_reason'),
  stateSince: tz('state_since').notNull().defaultNow(),
  archivedAt: archivedAt(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

/* ---------------- people and access ---------------- */
export const staffProfile = pgTable('staff_profile', {
  id: id(),
  employeeId: text('employee_id').notNull(),
  fullName: text('full_name').notNull(),
  gender: text('gender').$type<'male' | 'female'>(),
  department: text('department'),
  grade: integer('grade'),
  phone: text('phone'),
  email: text('email'),
  emergencyContact: text('emergency_contact'),
  employmentStatus: text('employment_status').$type<'active' | 'left'>().notNull().default('active'),
  joiningDate: date('joining_date'),
  leftAt: tz('left_at'),
  leftEffective: date('left_effective'),
  source: text('source').$type<'manual' | 'csv' | 'migration' | 'seed'>().notNull().default('manual'),
  archivedAt: archivedAt(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const userAccount = pgTable('user_account', {
  id: id(),
  staffId: uuid('staff_id').unique().references(() => staffProfile.id),
  username: text('username').notNull(),
  passwordHash: text('password_hash'),
  passwordChangedAt: tz('password_changed_at'),
  mustChangePassword: boolean('must_change_password').notNull().default(true),
  status: text('status').$type<'invited' | 'active' | 'locked' | 'revoked'>().notNull().default('invited'),
  failedLoginCount: integer('failed_login_count').notNull().default(0),
  lockedUntil: tz('locked_until'),
  lastLoginAt: tz('last_login_at'),
  revokedAt: tz('revoked_at'),
  archivedAt: archivedAt(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const roleAssignment = pgTable('role_assignment', {
  id: id(),
  userId: uuid('user_id').notNull().references(() => userAccount.id),
  role: text('role').$type<Role>().notNull(),
  scopeKind: text('scope_kind').$type<ScopeKind>().notNull(),
  siteId: uuid('site_id').references(() => site.id),
  buildingId: uuid('building_id').references(() => building.id),
  grantedBy: uuid('granted_by').references(() => userAccount.id),
  revokedAt: tz('revoked_at'),
  createdAt: createdAt(),
})

export const capabilityGrant = pgTable('capability_grant', {
  id: id(),
  userId: uuid('user_id').notNull().references(() => userAccount.id),
  capability: text('capability').$type<Capability>().notNull(),
  reason: text('reason').notNull(),
  startsAt: tz('starts_at').notNull().defaultNow(),
  expiresAt: tz('expires_at'),
  status: text('status').$type<GrantStatus>().notNull().default('pending'),
  makerId: uuid('maker_id').notNull().references(() => userAccount.id),
  checkerId: uuid('checker_id').references(() => userAccount.id),
  decidedAt: tz('decided_at'),
  revokedAt: tz('revoked_at'),
  createdAt: createdAt(),
})

export const session = pgTable('session', {
  id: id(),
  userId: uuid('user_id').notNull().references(() => userAccount.id),
  tokenHash: text('token_hash').notNull().unique(),
  createdAt: createdAt(),
  lastSeenAt: tz('last_seen_at').notNull().defaultNow(),
  expiresAt: tz('expires_at').notNull(),
  revokedAt: tz('revoked_at'),
  revokedReason: text('revoked_reason'),
  ip: inet('ip'),
  userAgent: text('user_agent'),
  activeRole: text('active_role').$type<Role>(),
})

export const delegation = pgTable('delegation', {
  id: id(),
  fromUserId: uuid('from_user_id').notNull().references(() => userAccount.id),
  toUserId: uuid('to_user_id').notNull().references(() => userAccount.id),
  startsOn: date('starts_on').notNull(),
  endsOn: date('ends_on').notNull(),
  reason: text('reason'),
  revokedAt: tz('revoked_at'),
  createdBy: uuid('created_by').references(() => userAccount.id),
  createdAt: createdAt(),
})

/* ---------------- audit and configuration (append-only) ---------------- */
export const auditEvent = pgTable('audit_event', {
  id: id(),
  seq: bigint('seq', { mode: 'number' }).generatedAlwaysAsIdentity(),
  actorUserId: uuid('actor_user_id').references(() => userAccount.id),
  actorRole: text('actor_role'),
  action: text('action').notNull(),
  entityType: text('entity_type'),
  entityId: uuid('entity_id'),
  siteId: uuid('site_id').references(() => site.id),
  reason: text('reason'),
  before: jsonb('before'),
  after: jsonb('after'),
  requestId: text('request_id'),
  ip: inet('ip'),
  createdAt: createdAt(),
})

export const configItem = pgTable('config_item', {
  id: id(),
  key: text('key').notNull(),
  scopeSiteId: uuid('scope_site_id').references(() => site.id),
  version: integer('version').notNull(),
  value: jsonb('value').notNull(),
  decisionRef: text('decision_ref'),
  decisionStatus: text('decision_status').$type<'decided' | 'default' | 'open'>(),
  reason: text('reason'),
  effectiveFrom: tz('effective_from').notNull().defaultNow(),
  createdBy: uuid('created_by').references(() => userAccount.id),
  createdAt: createdAt(),
})

/* ---------------- accommodation core ---------------- */
export const accommodationRequest = pgTable('accommodation_request', {
  id: id(),
  staffId: uuid('staff_id').notNull().references(() => staffProfile.id),
  siteId: uuid('site_id').notNull().references(() => site.id),
  submittedBy: uuid('submitted_by').references(() => userAccount.id),
  onBehalf: boolean('on_behalf').notNull().default(false),
  arrivalDate: date('arrival_date').notNull(),
  endDate: date('end_date'),
  stayType: text('stay_type').$type<StayTypeDb>().notNull(),
  note: text('note'),
  status: text('status').$type<RequestStatus>().notNull().default('submitted'),
  decidedBy: uuid('decided_by').references(() => userAccount.id),
  decidedAt: tz('decided_at'),
  decisionReason: text('decision_reason'),
  exceptionBy: uuid('exception_by').references(() => userAccount.id),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const bedClaim = pgTable('bed_claim', {
  id: id(),
  bedId: uuid('bed_id').notNull().references(() => bed.id),
  kind: text('kind').$type<ClaimKind>().notNull(),
  period: daterange('period').notNull(),
  releasedAt: tz('released_at'),
  releaseReason: text('release_reason'),
  createdAt: createdAt(),
})

export const reservation = pgTable('reservation', {
  id: id(),
  requestId: uuid('request_id').references(() => accommodationRequest.id),
  staffId: uuid('staff_id').notNull().references(() => staffProfile.id),
  bedId: uuid('bed_id').notNull(),
  claimId: uuid('claim_id').notNull().unique(),
  eta: tz('eta').notNull(),
  status: text('status').$type<ReservationStatus>().notNull().default('reserved'),
  source: text('source').$type<'request' | 'offer' | 'bulk' | 'migrated'>().notNull(),
  stayType: text('stay_type').$type<StayTypeDb>().notNull(),
  noShowExtended: boolean('no_show_extended').notNull().default(false),
  cancelReason: text('cancel_reason'),
  createdBy: uuid('created_by').references(() => userAccount.id),
  archivedAt: archivedAt(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const stay = pgTable('stay', {
  id: id(),
  staffId: uuid('staff_id').notNull().references(() => staffProfile.id),
  bedId: uuid('bed_id').notNull(),
  claimId: uuid('claim_id').notNull().unique(),
  reservationId: uuid('reservation_id').unique().references(() => reservation.id),
  status: text('status').$type<StayStatus>().notNull().default('active'),
  source: text('source').$type<'standard' | 'migrated' | 'provisional'>().notNull().default('standard'),
  stayType: text('stay_type').$type<StayTypeDb>().notNull(),
  checkedInAt: tz('checked_in_at').notNull().defaultNow(),
  checkedOutAt: tz('checked_out_at'),
  closedAt: tz('closed_at'),
  archivedAt: archivedAt(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const waitlistEntry = pgTable('waitlist_entry', {
  id: id(),
  staffId: uuid('staff_id').notNull().references(() => staffProfile.id),
  siteId: uuid('site_id').notNull().references(() => site.id),
  requestId: uuid('request_id').references(() => accommodationRequest.id),
  priority: text('priority'),
  queueTs: tz('queue_ts').notNull().defaultNow(),
  expiresAt: tz('expires_at').notNull(),
  declines: integer('declines').notNull().default(0),
  skipBedIds: uuid('skip_bed_ids').array().notNull().default([]),
  remindersSent: integer('reminders_sent').array().notNull().default([]),
  status: text('status').$type<WaitlistStatus>().notNull().default('waiting'),
  closeReason: text('close_reason'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const bedOffer = pgTable('bed_offer', {
  id: id(),
  staffId: uuid('staff_id').notNull().references(() => staffProfile.id),
  waitlistEntryId: uuid('waitlist_entry_id').references(() => waitlistEntry.id),
  bedId: uuid('bed_id').notNull(),
  claimId: uuid('claim_id').notNull().unique(),
  status: text('status').$type<OfferStatus>().notNull().default('pending'),
  deliveredAt: tz('delivered_at'),
  deliveredVia: text('delivered_via').$type<'viewed' | 'email' | 'offline'>(),
  expiresAt: tz('expires_at'),
  followUpSentAt: tz('follow_up_sent_at'),
  acceptedBy: uuid('accepted_by').references(() => userAccount.id),
  acceptedOnBehalf: boolean('accepted_on_behalf').notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const loginAttempt = pgTable('login_attempt', {
  id: id(),
  usernameNorm: text('username_norm').notNull(),
  ip: inet('ip'),
  succeeded: boolean('succeeded').notNull(),
  createdAt: createdAt(),
})

/** Every table above, for tests and tooling. Each Stage 1 package keeps its own tables in its own file. */
export const TABLES = {
  site, building, room, bed,
  staff_profile: staffProfile, user_account: userAccount, role_assignment: roleAssignment,
  capability_grant: capabilityGrant, session, delegation,
  audit_event: auditEvent, config_item: configItem,
  accommodation_request: accommodationRequest, bed_claim: bedClaim, reservation, stay,
  waitlist_entry: waitlistEntry, bed_offer: bedOffer,
  login_attempt: loginAttempt,
  ...TABLES_PROPERTY, ...TABLES_STAFF, ...TABLES_ACCESS,
  ...TABLES_ALLOC, ...TABLES_REQUESTS, ...TABLES_WAITLIST, ...TABLES_STAYS, ...TABLES_EMERGENCY,
} as const
