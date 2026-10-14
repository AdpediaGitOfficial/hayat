/**
 * Tables owned by WP-E (waitlist and bed offers, migration 0060). waitlist_entry and bed_offer exist since Stage 0 and
 * gained columns in 0060; this is their full description, re-exported by schema.ts. Foreign keys live in the migration;
 * plain uuid columns avoid a circular import with ./schema.
 */
import { boolean, date, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import type { OfferStatus, StayTypeDb, WaitlistStatus } from '@/domain/enums'

const id = () => uuid('id').primaryKey().defaultRandom()
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
const tz = (name: string) => timestamp(name, { withTimezone: true })

export const waitlistEntry = pgTable('waitlist_entry', {
  id: id(),
  staffId: uuid('staff_id').notNull(),
  siteId: uuid('site_id').notNull(),
  requestId: uuid('request_id'),
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
  arrivalDate: date('arrival_date').notNull(),
  endDate: date('end_date'),
  stayType: text('stay_type').$type<StayTypeDb>().notNull(),
  renewals: integer('renewals').notNull().default(0),
  onBehalf: boolean('on_behalf').notNull().default(false),
  createdBy: uuid('created_by'),
  closedAt: tz('closed_at'),
})

export const bedOffer = pgTable('bed_offer', {
  id: id(),
  staffId: uuid('staff_id').notNull(),
  waitlistEntryId: uuid('waitlist_entry_id'),
  bedId: uuid('bed_id').notNull(),
  claimId: uuid('claim_id').notNull().unique(),
  status: text('status').$type<OfferStatus>().notNull().default('pending'),
  deliveredAt: tz('delivered_at'),
  deliveredVia: text('delivered_via').$type<'viewed' | 'email' | 'offline'>(),
  expiresAt: tz('expires_at'),
  followUpSentAt: tz('follow_up_sent_at'),
  acceptedBy: uuid('accepted_by'),
  acceptedOnBehalf: boolean('accepted_on_behalf').notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  createdBy: uuid('created_by'),
  deliveredBy: uuid('delivered_by'),
  deliveryNote: text('delivery_note'),
  consentNote: text('consent_note'),
  respondedAt: tz('responded_at'),
  responseNote: text('response_note'),
})

export const PRIORITY_STATUSES = ['pending', 'approved', 'rejected', 'withdrawn'] as const
export type PriorityStatus = (typeof PRIORITY_STATUSES)[number]

export const waitlistPriorityRequest = pgTable('waitlist_priority_request', {
  id: id(),
  entryId: uuid('entry_id').notNull(),
  staffId: uuid('staff_id').notNull(),
  siteId: uuid('site_id').notNull(),
  category: text('category').notNull(),
  reason: text('reason').notNull(),
  evidence: text('evidence').notNull(),
  status: text('status').$type<PriorityStatus>().notNull().default('pending'),
  requestedBy: uuid('requested_by').notNull(),
  decidedBy: uuid('decided_by'),
  decidedAt: tz('decided_at'),
  decisionNote: text('decision_note'),
  positionBefore: integer('position_before'),
  positionAfter: integer('position_after'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

/** waitlist_entry and bed_offer are registered by schema.ts (they exist since Stage 0); this registers the new tables. */
export const TABLES_WAITLIST = {
  waitlist_priority_request: waitlistPriorityRequest,
} as const
