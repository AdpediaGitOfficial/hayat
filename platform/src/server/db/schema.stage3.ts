/** Stage 3 core tables (migration 0090): attachments, handover items and their event log, cleaning tasks.
 *  Foreign keys live in the migration; plain uuid columns avoid a circular import with ./schema. */
import { boolean, date, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

const id = () => uuid('id').primaryKey().defaultRandom()
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
const tz = (name: string) => timestamp(name, { withTimezone: true })

export type HandoverStatus = 'in_cabinet' | 'issued' | 'lost' | 'damaged' | 'retired'
export type HandoverEventKind = 'issued' | 'returned' | 'lost' | 'damaged' | 'retired' | 'replaced' | 'found'
export type CleaningStatus = 'open' | 'cleaned' | 'passed' | 'failed' | 'cancelled'

export const attachment = pgTable('attachment', {
  id: id(),
  entityType: text('entity_type').notNull(),
  entityId: uuid('entity_id').notNull(),
  siteId: uuid('site_id'),
  filename: text('filename').notNull(),
  contentType: text('content_type').$type<'image/png' | 'image/jpeg' | 'application/pdf'>().notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  sha256: text('sha256').notNull(),
  storageKey: text('storage_key').notNull(),
  uploadedBy: uuid('uploaded_by').notNull(),
  createdAt: createdAt(),
})

export const handoverItem = pgTable('handover_item', {
  id: id(),
  category: text('category').$type<'key' | 'asset'>().notNull(),
  itemType: text('item_type').notNull(),
  code: text('code').notNull(),
  siteId: uuid('site_id').notNull(),
  roomId: uuid('room_id'),
  bedId: uuid('bed_id'),
  status: text('status').$type<HandoverStatus>().notNull().default('in_cabinet'),
  holderStaffId: uuid('holder_staff_id'),
  issuedAt: tz('issued_at'),
  dueBack: date('due_back'),
  replacedBy: uuid('replaced_by'),
  note: text('note'),
  archivedAt: tz('archived_at'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const handoverEvent = pgTable('handover_event', {
  id: id(),
  itemId: uuid('item_id').notNull(),
  kind: text('kind').$type<HandoverEventKind>().notNull(),
  staffId: uuid('staff_id'),
  actorUserId: uuid('actor_user_id'),
  onBehalf: boolean('on_behalf').notNull().default(false),
  note: text('note'),
  createdAt: createdAt(),
})

export const cleaningTask = pgTable('cleaning_task', {
  id: id(),
  bedId: uuid('bed_id').notNull(),
  siteId: uuid('site_id').notNull(),
  reason: text('reason').notNull(),
  status: text('status').$type<CleaningStatus>().notNull().default('open'),
  assignedToStaff: uuid('assigned_to_staff'),
  assignedBy: uuid('assigned_by'),
  assignedAt: tz('assigned_at'),
  cleanedByStaff: uuid('cleaned_by_staff'),
  cleanedAt: tz('cleaned_at'),
  checklist: jsonb('checklist'),
  inspectedByStaff: uuid('inspected_by_staff'),
  inspectedBy: uuid('inspected_by'),
  inspectedAt: tz('inspected_at'),
  inspectionNote: text('inspection_note'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const TABLES_STAGE3 = { attachment, handover_item: handoverItem, handover_event: handoverEvent, cleaning_task: cleaningTask } as const
