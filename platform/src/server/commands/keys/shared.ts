/**
 * Helpers shared by the keys and assets commands (WP-I, Stage 3): inputs, loaders that take the right lock, the
 * "who may move an item" check, the rule for who may hold which item, the event log and closing of stays.
 *
 * Locking order, everywhere: item row (FOR UPDATE) -> staff row (FOR SHARE) -> room (FOR SHARE) -> bed (FOR SHARE).
 * Two simultaneous issues of one key queue on the item row and exactly one wins; archiving a bed or room takes
 * the structure FOR UPDATE, so "issue a key on this bed" and "archive this bed" cannot both succeed.
 *
 * A lost or damaged item is never "returned" (D-73): the only exits are retire, replace and (for lost) found.
 */
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { z } from 'zod'
import { bed, reservation, room, staffProfile, stay } from '@/server/db/schema'
import { handoverEvent, handoverItem, type HandoverEventKind, type HandoverStatus } from '@/server/db/schema.stage3'
import type { CommandContext, Tx } from '@/server/command/context'
import type { Db } from '@/server/db/client'
import { fail, failure, type Failure } from '@/server/command/result'
import { decide, type Action } from '@/server/policy'
import { OCCUPYING_STAY_STATUSES } from '@/domain/enums'
import { closeStayIfDone } from '@/server/stays-close'
import { getConfig } from '@/server/config/registry'
import { codeSchema, idSchema, optionalText, reasonSchema } from '@/server/commands/property/shared'

export { codeSchema, idSchema, optionalText, reasonSchema, todayInZone } from '@/server/commands/property/shared'

export type ItemRow = typeof handoverItem.$inferSelect

/* ---------------- inputs ---------------- */

export const categorySchema = z.enum(['key', 'asset'])
export const itemTypeSchema = z.string().trim().regex(/^[a-z0-9_]{1,40}$/, 'Pick one of the configured types')
export const dateSchema = z.iso.date('Use a date like 2026-11-30')
export const noteSchema = optionalText(500)
export const attachmentIdsSchema = z.array(idSchema).max(10, 'At most 10 files').optional()

/* ---------------- who may do what ---------------- */

/** Reception, Night Keys holders (Security) and the administrators may hand items out and take them back. */
export const MOVE_ACTIONS: readonly Action[] = ['keys.manage', 'keys.issue_return', 'keys.issue_return_night']
/** Every action that shows keys in some scope (Night Keys holders need the cabinet to do their work). */
export const KEY_ACTIONS: readonly Action[] = ['keys.view', ...MOVE_ACTIONS]

/**
 * The actor may do the thing if ANY of the actions is granted for this site. A grant that cannot reach the site reads as
 * "not found" (AT-001/002); no grant at all is "forbidden".
 */
export function authorizeAny(c: Pick<CommandContext, 'actor'>, actions: readonly Action[], siteId: string): Failure | undefined {
  let outOfScope = false
  for (const a of actions) {
    const d = decide(c.actor, a, { siteId })
    if (d.allowed) return undefined
    if (d.reason === 'out_of_scope') outOfScope = true
  }
  return outOfScope ? fail.notFound() : fail.forbidden('hand out or take back keys and assets')
}

/* ---------------- loaders ---------------- */

export async function loadItemLocked(tx: Tx, id: string): Promise<ItemRow | undefined> {
  return (await tx.select().from(handoverItem).where(eq(handoverItem.id, id)).limit(1).for('update'))[0]
}

export async function staffRow(tx: Tx, id: string, lock: 'share' | false = false) {
  const q = tx.select({ id: staffProfile.id, name: staffProfile.fullName, employeeId: staffProfile.employeeId, status: staffProfile.employmentStatus, archivedAt: staffProfile.archivedAt })
    .from(staffProfile).where(eq(staffProfile.id, id)).limit(1)
  return (lock ? await q.for('share') : await q)[0]
}
export type StaffInfo = NonNullable<Awaited<ReturnType<typeof staffRow>>>
export const who = (s: Pick<StaffInfo, 'name' | 'employeeId'>) => `${s.name} (${s.employeeId})`

/* ---------------- item types (configuration, D-72 is open) ---------------- */

export async function itemTypeFailure(tx: Tx, category: 'key' | 'asset', itemType: string): Promise<Failure | undefined> {
  const types = await getConfig(tx, 'keys.item_types')
  const t = types.find(x => x.id === itemType)
  if (!t) return fail.invalid(`"${itemType}" is not a configured key or asset type`, { itemType: 'Not a configured type' })
  if (t.category !== category) return fail.invalid(`${t.label} is a ${t.category}, not a ${category}`, { itemType: `This type is a ${t.category}` })
  return undefined
}

/* ---------------- links to a room or a bed ---------------- */

/**
 * A room key and a bed locker key are both just items linked to a room or a bed (D-72). Both must belong to the item's site and
 * be active. Rooms are locked before beds (the structure order) and FOR SHARE, so an archive of either waits for us or is seen.
 */
export async function resolveLinks(tx: Tx, siteId: string, roomId: string | null | undefined, bedId: string | null | undefined): Promise<{ roomId: string | null; bedId: string | null } | Failure> {
  let r: typeof room.$inferSelect | undefined
  if (roomId) {
    r = (await tx.select().from(room).where(eq(room.id, roomId)).limit(1).for('share'))[0]
    if (!r || r.siteId !== siteId) return fail.invalid('That room is not part of this site', { roomId: 'Not found in this site' })
    if (r.archivedAt) return failure('conflict', `Room ${r.name} is archived`, { owner: 'Accommodation Admin', next: 'Link the item to an active room, or to none' })
  }
  if (bedId) {
    const b = (await tx.select().from(bed).where(eq(bed.id, bedId)).limit(1).for('share'))[0]
    if (!b || b.siteId !== siteId) return fail.invalid('That bed is not part of this site', { bedId: 'Not found in this site' })
    if (b.archivedAt) return failure('conflict', `Bed ${b.code} is archived`, { owner: 'Accommodation Admin', next: 'Link the item to an active bed, or to none' })
    if (r && b.roomId !== r.id) return fail.invalid('That bed is not in that room', { bedId: 'Not in the chosen room' })
  }
  return { roomId: roomId ?? null, bedId: bedId ?? null }
}

/* ---------------- who may hold an item ---------------- */

type Reader = Pick<Db, 'select'>

/**
 * Why this person may NOT be given this item, or undefined when they may. Rules: an active employee; for an item linked to a
 * bed, a live stay in that bed or a reservation for it; for an item linked to a room, the same for any bed of the room.
 * An item with no link (an access card) needs only an active employee.
 */
export async function holdabilityProblem(q: Reader, item: Pick<ItemRow, 'bedId' | 'roomId'>, p: Pick<StaffInfo, 'status' | 'archivedAt' | 'name'>, staffId: string): Promise<{ reason: string; code: 'inactive' | 'no_stay_in_bed' } | undefined> {
  if (p.status !== 'active' || p.archivedAt) return { code: 'inactive', reason: `${p.name} is not an active employee, so nothing can be issued to them` }
  if (!item.bedId && !item.roomId) return undefined
  const bedFilter = item.bedId ? eq(stay.bedId, item.bedId) : inArray(stay.bedId, q.select({ id: bed.id }).from(bed).where(eq(bed.roomId, item.roomId!)))
  const [s] = await q.select({ id: stay.id }).from(stay).where(and(eq(stay.staffId, staffId), inArray(stay.status, [...OCCUPYING_STAY_STATUSES]), isNull(stay.archivedAt), bedFilter)).limit(1)
  if (s) return undefined
  const resBed = item.bedId ? eq(reservation.bedId, item.bedId) : inArray(reservation.bedId, q.select({ id: bed.id }).from(bed).where(eq(bed.roomId, item.roomId!)))
  const [r] = await q.select({ id: reservation.id }).from(reservation).where(and(eq(reservation.staffId, staffId), eq(reservation.status, 'reserved'), isNull(reservation.archivedAt), resBed)).limit(1)
  if (r) return undefined
  return { code: 'no_stay_in_bed', reason: `${p.name} has no stay or reservation in ${item.bedId ? 'the bed' : 'the room'} this item belongs to` }
}

export const holdFailure = (p: { reason: string; code: string }) => p.code === 'inactive'
  ? failure('conflict', p.reason, { owner: 'Accommodation Admin', next: 'Check the staff record. Keys are only issued to active employees', detail: { reason: p.code } })
  : failure('conflict', p.reason, { owner: 'Accommodation Admin', next: 'Check the person in first, or choose the key for their own bed or room', detail: { reason: p.code } })

/* ---------------- state changes ---------------- */

export const itemSnap = (i: Pick<ItemRow, 'status' | 'holderStaffId' | 'code' | 'itemType' | 'dueBack' | 'bedId' | 'roomId' | 'replacedBy'>) =>
  ({ code: i.code, itemType: i.itemType, status: i.status, holderStaffId: i.holderStaffId, dueBack: i.dueBack, bedId: i.bedId, roomId: i.roomId, replacedBy: i.replacedBy })

/**
 * Appends to the item's history. The caller holds the item row lock, so the time can be made strictly increasing per item
 * (never earlier than the previous event): the history reads in the order things happened even when two movements share a clock tick.
 */
export async function logEvent(c: CommandContext, e: { itemId: string; kind: HandoverEventKind; staffId?: string | null; onBehalf?: boolean; note?: string | null }): Promise<string> {
  const [last] = await c.tx.select({ at: sql<Date | null>`max(${handoverEvent.createdAt})` }).from(handoverEvent).where(eq(handoverEvent.itemId, e.itemId))
  const prev = last?.at ? new Date(last.at).getTime() : 0
  const at = prev >= c.now.getTime() ? new Date(prev + 1) : c.now
  const [row] = await c.tx.insert(handoverEvent).values({
    itemId: e.itemId, kind: e.kind, staffId: e.staffId ?? null, actorUserId: c.user.id, onBehalf: e.onBehalf ?? false, note: e.note ?? null, createdAt: at,
  }).returning({ id: handoverEvent.id })
  return row.id
}

/** Sets the status and the holder together (the database keeps issued and holder in step) and returns nothing else to remember. */
export async function setState(c: CommandContext, id: string, to: { status: HandoverStatus; holderStaffId: string | null; issuedAt: Date | null; dueBack: string | null }, extra: { replacedBy?: string } = {}) {
  await c.tx.update(handoverItem).set({ status: to.status, holderStaffId: to.holderStaffId, issuedAt: to.issuedAt, dueBack: to.dueBack, ...extra }).where(eq(handoverItem.id, id))
}

/**
 * Something a person held has been resolved (returned, found, retired): their checked-out stays may now be able to close
 * (D-64: whichever finishes last closes the stay). Returns the stays that closed.
 */
export async function closeStaysOf(c: CommandContext, staffId: string): Promise<string[]> {
  const rows = await c.tx.select({ id: stay.id }).from(stay).where(and(eq(stay.staffId, staffId), eq(stay.status, 'checked_out'))).orderBy(asc(stay.id))
  const closed: string[] = []
  for (const s of rows) if (await closeStayIfDone(c.tx, s.id, c.now)) closed.push(s.id)
  return closed
}

export const NOT_RETURNABLE = (status: 'lost' | 'damaged') => failure('conflict',
  `This item is ${status}. A ${status} item is never marked returned`, {
    owner: 'Accommodation Admin', next: status === 'lost' ? 'Mark it found if it turns up, or retire or replace it' : 'Retire it, or replace it with a new one', detail: { reason: `${status}_not_returnable`, status },
  })

export const archivedFailure = () => failure('conflict', 'This item is archived', { owner: 'Accommodation Admin', next: 'Create a new item instead', detail: { reason: 'archived' } })
