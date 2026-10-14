/** Typed definitions for tables added by WP-A: property setup (migrations in db/migrations). Register each table in TABLES_PROPERTY. */
import { date, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

/** The history of blocks on a bed (0010). One block is open per bed; releasing it sets released_at. Never deleted. */
export const bedBlock = pgTable('bed_block', {
  id: uuid('id').primaryKey().defaultRandom(),
  bedId: uuid('bed_id').notNull(),
  siteId: uuid('site_id').notNull(),
  reason: text('reason').notNull(),
  /** LAST blocked day (inclusive, D-103 note); null = until further notice. */
  untilDate: date('until_date'),
  blockedBy: uuid('blocked_by'),
  blockedAt: timestamp('blocked_at', { withTimezone: true }).notNull().defaultNow(),
  releasedAt: timestamp('released_at', { withTimezone: true }),
  releasedBy: uuid('released_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const TABLES_PROPERTY = { bed_block: bedBlock } as const
