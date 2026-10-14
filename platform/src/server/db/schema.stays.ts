/**
 * Tables owned by WP-F (migration 0070): extension, transfer/swap and voluntary checkout requests.
 * Foreign keys live in the migration; plain uuid columns here avoid a circular import with ./schema.
 * Register each table in TABLES_STAYS (schema-sync compares them with the database).
 */
import { boolean, date, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

const id = () => uuid('id').primaryKey().defaultRandom()
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
const tz = (name: string) => timestamp(name, { withTimezone: true })

export type ExtensionStatus = 'requested' | 'approved' | 'rejected' | 'cancelled'
export type TransferStatus = 'requested' | 'approved' | 'rejected' | 'executed' | 'failed' | 'cancelled'
export type CheckoutRequestStatus = 'requested' | 'acknowledged' | 'completed' | 'cancelled'
export type ConsentVia = 'in_app' | 'in_person' | 'phone' | 'written'

export const extensionRequest = pgTable('extension_request', {
  id: id(),
  siteId: uuid('site_id').notNull(),
  stayId: uuid('stay_id').notNull(),
  staffId: uuid('staff_id').notNull(),
  requestedBy: uuid('requested_by'),
  requestedByStaffId: uuid('requested_by_staff_id'),
  currentEnd: date('current_end').notNull(),
  newEnd: date('new_end').notNull(),
  addedDays: integer('added_days').notNull(),
  beyondPolicy: boolean('beyond_policy').notNull().default(false),
  reason: text('reason'),
  status: text('status').$type<ExtensionStatus>().notNull().default('requested'),
  clash: jsonb('clash'),
  decidedBy: uuid('decided_by'),
  decidedAt: tz('decided_at'),
  decisionReason: text('decision_reason'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const transferRequest = pgTable('transfer_request', {
  id: id(),
  kind: text('kind').$type<'transfer' | 'swap'>().notNull(),
  /** The SOURCE site (for a swap: the site of the first stay). */
  siteId: uuid('site_id').notNull(),
  /** The site the resident moves INTO (migration 0130, D-104; for a swap: the site of the second stay). Equal to siteId for a same-site move. */
  destinationSiteId: uuid('destination_site_id').notNull(),
  stayId: uuid('stay_id').notNull(),
  staffId: uuid('staff_id').notNull(),
  fromBedId: uuid('from_bed_id').notNull(),
  toBedId: uuid('to_bed_id'),
  otherStayId: uuid('other_stay_id'),
  otherStaffId: uuid('other_staff_id'),
  reason: text('reason').notNull(),
  neededBy: date('needed_by'),
  linkedExtensionId: uuid('linked_extension_id'),
  status: text('status').$type<TransferStatus>().notNull().default('requested'),
  requestedBy: uuid('requested_by'),
  requestedByStaffId: uuid('requested_by_staff_id'),
  consentAAt: tz('consent_a_at'),
  consentABy: uuid('consent_a_by'),
  consentAVia: text('consent_a_via').$type<ConsentVia>(),
  consentANote: text('consent_a_note'),
  consentBAt: tz('consent_b_at'),
  consentBBy: uuid('consent_b_by'),
  consentBVia: text('consent_b_via').$type<ConsentVia>(),
  consentBNote: text('consent_b_note'),
  /** The two keys (D-104): an Accommodation Admin of the source site and one of the destination site. A same-site decision gives both. */
  sourceApprovedBy: uuid('source_approved_by'),
  sourceApprovedAt: tz('source_approved_at'),
  destinationApprovedBy: uuid('destination_approved_by'),
  destinationApprovedAt: tz('destination_approved_at'),
  /** Who gave the LAST key, and when (the request is Approved from then on). */
  decidedBy: uuid('decided_by'),
  decidedAt: tz('decided_at'),
  decisionReason: text('decision_reason'),
  executedBy: uuid('executed_by'),
  executedAt: tz('executed_at'),
  newClaimId: uuid('new_claim_id'),
  otherNewClaimId: uuid('other_new_claim_id'),
  failureCount: integer('failure_count').notNull().default(0),
  failedAt: tz('failed_at'),
  failureReason: text('failure_reason'),
  failureDetail: jsonb('failure_detail'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const checkoutRequest = pgTable('checkout_request', {
  id: id(),
  siteId: uuid('site_id').notNull(),
  stayId: uuid('stay_id').notNull(),
  staffId: uuid('staff_id').notNull(),
  requestedBy: uuid('requested_by'),
  departureDate: date('departure_date').notNull(),
  note: text('note'),
  status: text('status').$type<CheckoutRequestStatus>().notNull().default('requested'),
  acknowledgedBy: uuid('acknowledged_by'),
  acknowledgedAt: tz('acknowledged_at'),
  completedBy: uuid('completed_by'),
  completedAt: tz('completed_at'),
  cancelledAt: tz('cancelled_at'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

/** A Policy Approver's decline of a transfer exception (migration 0160, P-10 proposed, pending client sign-off). A grant is an eligibility_exception row. Append-only. */
export const transferExceptionDecision = pgTable('transfer_exception_decision', {
  id: id(),
  transferRequestId: uuid('transfer_request_id').notNull(),
  staffId: uuid('staff_id').notNull(),
  bedId: uuid('bed_id').notNull(),
  siteId: uuid('site_id').notNull(),
  decision: text('decision').$type<'declined'>().notNull(),
  reason: text('reason').notNull(),
  decidedBy: uuid('decided_by').notNull(),
  createdAt: createdAt(),
})

export const TABLES_STAYS = {
  extension_request: extensionRequest,
  transfer_request: transferRequest,
  checkout_request: checkoutRequest,
  transfer_exception_decision: transferExceptionDecision,
} as const
