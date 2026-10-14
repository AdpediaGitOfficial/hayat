/**
 * The item registry (WP-I): which keys and assets exist at a site. Super Admin and Accommodation Admin inside their sites
 * (`keys.manage`). Item types are configuration (`keys.item_types`, D-72 is open): a room key and a bed locker key are both
 * just items linked to a room or a bed. Codes are unique per site and category, case-insensitively (a partial unique index,
 * so an archived item frees its code). Nothing is ever deleted: an item that is no longer needed is retired or archived.
 * This is not a stock system: one row per physical key or asset.
 */
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { handoverItem } from '@/server/db/schema.stage3'
import { audit } from '@/server/audit'
import { authorize } from '@/server/command/authorize'
import { runCommand } from '@/server/command/run'
import type { CommandContext, RequestContext } from '@/server/command/context'
import { fail, failure, ok, type Result } from '@/server/command/result'
import { duplicate, guardUnique, loadSite } from '@/server/commands/property/shared'
import {
  archivedFailure, categorySchema, codeSchema, idSchema, itemSnap, itemTypeFailure, itemTypeSchema, loadItemLocked, noteSchema, reasonSchema, resolveLinks, type ItemRow,
} from './shared'

const MAX_BULK = 200

/* ---------------- create one ---------------- */

export const createInput = z.object({
  siteId: idSchema,
  category: categorySchema,
  itemType: itemTypeSchema,
  code: codeSchema,
  roomId: idSchema.nullish().transform(v => v ?? null),
  bedId: idSchema.nullish().transform(v => v ?? null),
  note: noteSchema,
})
export type CreateItemInput = z.infer<typeof createInput>
export interface CreateItemOut { id: string; code: string }

/** Everything about a new item that does not depend on its code: the site, the type and the links. */
async function prepare(c: CommandContext, i: Pick<CreateItemInput, 'siteId' | 'category' | 'itemType' | 'roomId' | 'bedId'>) {
  const denied = authorize(c, 'keys.manage', { siteId: i.siteId })
  if (denied) return denied
  const s = await loadSite(c.tx, i.siteId, 'share')
  if (!s) return fail.notFound()
  if (s.archivedAt) return failure('conflict', `Site ${s.name} is archived`, { owner: 'Super Admin', next: 'Choose an active site' })
  const bad = await itemTypeFailure(c.tx, i.category, i.itemType)
  if (bad) return bad
  const links = await resolveLinks(c.tx, i.siteId, i.roomId, i.bedId)
  if ('ok' in links) return links
  return links
}

export function createItem(rc: RequestContext, i: CreateItemInput): Promise<Result<CreateItemOut>> {
  return runCommand(rc, async c => {
    const links = await prepare(c, i)
    if ('ok' in links) return links
    const rows = await guardUnique(c.tx, q => q.insert(handoverItem).values({
      category: i.category, itemType: i.itemType, code: i.code, siteId: i.siteId, roomId: links.roomId, bedId: links.bedId, note: i.note, createdAt: c.now, updatedAt: c.now,
    }).returning())
    if (!rows) return duplicate('code', `There is already a ${i.category} with code "${i.code}" at this site`, 'Use a different code. Codes are unique per site and category, ignoring capitals')
    const row = rows[0]
    await audit(c, { action: 'keys.item.created', entityType: 'handover_item', entityId: row.id, siteId: row.siteId, after: itemSnap(row) })
    return ok({ id: row.id, code: row.code }, `${i.category === 'key' ? 'Key' : 'Asset'} ${row.code} added to the cabinet`)
  })
}

/* ---------------- create many ---------------- */

export const bulkInput = z.object({
  siteId: idSchema,
  category: categorySchema,
  itemType: itemTypeSchema,
  roomId: idSchema.nullish().transform(v => v ?? null),
  bedId: idSchema.nullish().transform(v => v ?? null),
  note: noteSchema,
  /** Either a prefix and a count ("R12-" and 4 gives R12-01 to R12-04) ... */
  prefix: z.string().trim().max(30).optional(),
  count: z.number().int().min(1).max(MAX_BULK).optional(),
  start: z.number().int().min(0).max(100000).optional(),
  /** ... or an explicit list of codes. */
  codes: z.array(z.string()).min(1).max(MAX_BULK).optional(),
}).refine(v => (v.codes !== undefined) !== (v.count !== undefined), { message: 'Give either a list of codes, or a prefix and a count', path: ['codes'] })
export type BulkCreateInput = z.infer<typeof bulkInput>
export interface BulkRow { code: string; ok: boolean; id?: string; error?: string }
export interface BulkOut { created: number; failed: number; rows: BulkRow[] }

export function expandCodes(i: Pick<BulkCreateInput, 'prefix' | 'count' | 'start' | 'codes'>): string[] {
  if (i.codes) return i.codes.map(x => x.trim())
  const start = i.start ?? 1, count = i.count ?? 0
  const width = Math.max(2, String(start + count - 1).length)
  return Array.from({ length: count }, (_, n) => `${(i.prefix ?? '').trim()}${String(start + n).padStart(width, '0')}`)
}

/** Each code succeeds or fails on its own and the answer lists every one; a bad row never stops the others. */
export function bulkCreateItems(rc: RequestContext, i: BulkCreateInput): Promise<Result<BulkOut>> {
  return runCommand(rc, async c => {
    const links = await prepare(c, i)
    if ('ok' in links) return links
    const rows: BulkRow[] = []
    for (const code of expandCodes(i)) {
      const parsed = codeSchema.safeParse(code)
      if (!parsed.success) { rows.push({ code, ok: false, error: parsed.error.issues[0]?.message ?? 'Not a valid code' }); continue }
      const made = await guardUnique(c.tx, q => q.insert(handoverItem).values({
        category: i.category, itemType: i.itemType, code: parsed.data, siteId: i.siteId, roomId: links.roomId, bedId: links.bedId, note: i.note, createdAt: c.now, updatedAt: c.now,
      }).returning())
      if (!made) { rows.push({ code: parsed.data, ok: false, error: 'Already exists at this site' }); continue }
      await audit(c, { action: 'keys.item.created', entityType: 'handover_item', entityId: made[0].id, siteId: i.siteId, after: itemSnap(made[0]) })
      rows.push({ code: parsed.data, ok: true, id: made[0].id })
    }
    const created = rows.filter(r => r.ok).length
    await audit(c, { action: 'keys.item.bulk_created', entityType: 'site', entityId: i.siteId, siteId: i.siteId, after: { itemType: i.itemType, created, failed: rows.length - created } })
    return ok({ created, failed: rows.length - created, rows }, created === rows.length ? `${created} item${created === 1 ? '' : 's'} added` : `${created} added, ${rows.length - created} not added (see the list)`)
  })
}

/* ---------------- update ---------------- */

export const updateInput = z.object({
  id: idSchema,
  /** undefined = keep, null or empty = clear. */
  note: z.string().trim().max(500, 'At most 500 characters').nullable().optional(),
  roomId: idSchema.nullable().optional(),
  bedId: idSchema.nullable().optional(),
})
export type UpdateItemInput = z.infer<typeof updateInput>

/** The note, and the room or bed an item belongs to. The links of an item that is out of the cabinet do not change: it would move a person's obligations. */
export function updateItem(rc: RequestContext, i: UpdateItemInput): Promise<Result<{ id: string }>> {
  return runCommand(rc, async c => {
    const item = await loadItemLocked(c.tx, i.id)
    if (!item) return fail.notFound()
    const denied = authorize(c, 'keys.manage', { siteId: item.siteId })
    if (denied) return denied
    if (item.archivedAt) return archivedFailure()
    const set: Partial<ItemRow> = {}
    if (i.note !== undefined) set.note = i.note ? i.note : null
    if (i.roomId !== undefined || i.bedId !== undefined) {
      if (item.status !== 'in_cabinet') {
        return failure('conflict', `The links of an item that is ${item.status.replace('_', ' ')} cannot change`, {
          owner: 'Reception', next: item.status === 'issued' ? 'Record its return first, then change the links' : 'Resolve it first (found, replaced or retired)', detail: { reason: 'links_locked', status: item.status },
        })
      }
      const links = await resolveLinks(c.tx, item.siteId, i.roomId === undefined ? item.roomId : i.roomId, i.bedId === undefined ? item.bedId : i.bedId)
      if ('ok' in links) return links
      set.roomId = links.roomId; set.bedId = links.bedId
    }
    if (Object.keys(set).length === 0) return ok({ id: item.id }, 'Nothing changed')
    await c.tx.update(handoverItem).set(set).where(eq1(item.id))
    await audit(c, { action: 'keys.item.updated', entityType: 'handover_item', entityId: item.id, siteId: item.siteId, before: { note: item.note, roomId: item.roomId, bedId: item.bedId }, after: { note: set.note ?? item.note, roomId: set.roomId ?? item.roomId, bedId: set.bedId ?? item.bedId } })
    return ok({ id: item.id }, 'Item updated')
  })
}

const eq1 = (id: string) => eq(handoverItem.id, id)

/* ---------------- archive ---------------- */

export const archiveInput = z.object({ id: idSchema, reason: reasonSchema })
export type ArchiveItemInput = z.infer<typeof archiveInput>

/** Takes an item out of the registry (frees its code). Never while it is issued, lost or damaged: those are somebody's obligation. */
export function archiveItem(rc: RequestContext, i: ArchiveItemInput): Promise<Result<{ id: string }>> {
  return runCommand(rc, async c => {
    const item = await loadItemLocked(c.tx, i.id)
    if (!item) return fail.notFound()
    const denied = authorize(c, 'keys.manage', { siteId: item.siteId })
    if (denied) return denied
    if (item.archivedAt) return ok({ id: item.id }, 'Already archived')
    if (item.status === 'issued' || item.status === 'lost' || item.status === 'damaged') {
      return failure('conflict', `${item.code} is ${item.status === 'issued' ? 'issued to someone' : item.status}, so it cannot be archived`, {
        owner: 'Reception', next: item.status === 'issued' ? 'Record its return first' : 'Mark it found, or retire or replace it first', detail: { reason: 'outstanding', status: item.status },
      })
    }
    await c.tx.update(handoverItem).set({ archivedAt: c.now }).where(eq1(item.id))
    await audit(c, { action: 'keys.item.archived', entityType: 'handover_item', entityId: item.id, siteId: item.siteId, reason: i.reason, before: { status: item.status }, after: { archived: true } })
    return ok({ id: item.id }, `${item.code} archived. It stays in the history`)
  })
}
