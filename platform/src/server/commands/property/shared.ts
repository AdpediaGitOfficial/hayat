/**
 * Helpers shared by the property commands (WP-A): input building blocks, row loaders that take the right lock,
 * and the "site-local today" used for block dates.
 *
 * Locking order, top-down, everywhere: building -> room -> bed. Creating a child takes its parent FOR SHARE;
 * archiving takes the structure FOR UPDATE and then re-checks, so "create under it" and "archive it" serialise
 * and exactly one of them wins (AT-029, STAGE-1 section 4).
 */
import { and, asc, eq, inArray, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { bed, building, room, site } from '@/server/db/schema'
import type { Tx } from '@/server/command/context'
import { failure } from '@/server/command/result'

export type SiteRow = typeof site.$inferSelect
export type BuildingRow = typeof building.$inferSelect
export type RoomRow = typeof room.$inferSelect
export type BedRow = typeof bed.$inferSelect

/* ---------------- input building blocks ---------------- */

export const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)
export const idSchema = z.uuid('Not a valid identifier')
export const codeSchema = z.string().trim()
  .min(1, 'Required').max(40, 'At most 40 characters')
  .regex(/^[A-Za-z0-9][A-Za-z0-9 ._/-]*$/, 'Letters, digits, spaces and . _ - / only')
export const nameSchema = z.string().trim().min(1, 'Required').max(120, 'At most 120 characters')
export const reasonSchema = z.string().trim().min(3, 'Give a reason (at least 3 characters)').max(500, 'At most 500 characters')
/** Empty / missing becomes null, so "clear this field" and "leave it empty" mean the same thing. */
export const optionalText = (max: number) => z.string().trim().max(max, `At most ${max} characters`).nullish().transform(v => (v ? v : null))

/** For updates: undefined = keep as is, null or empty = clear. (No transform, so "left out" can never turn into "cleared".) */
export const clearableText = (max: number) => z.string().trim().max(max, `At most ${max} characters`).nullable().optional()

export function isValidTimeZone(tz: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true } catch { return false }
}
export const timeZoneSchema = z.string().trim().min(1, 'Required').max(64)
  .refine(isValidTimeZone, 'Not a valid time zone (for example Asia/Dubai)')

export const SITE_KINDS = ['villa', 'apartment', 'other'] as const
export const GENDER_POLICIES = ['any', 'male', 'female'] as const

/** 'YYYY-MM-DD' of an instant in a time zone (G-01: the site decides what "today" is). */
export function todayInZone(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}

/* ---------------- failures ---------------- */

/** A duplicate business key, reported on the field that caused it. */
export const duplicate = (field: string, reason: string, next: string) =>
  failure('conflict', reason, { owner: 'The person creating it', next, fields: { [field]: 'Already in use' } })

export function isUniqueViolation(e: unknown): boolean {
  const err = e as { code?: string; cause?: { code?: string } } | null
  return err?.code === '23505' || err?.cause?.code === '23505'
}

/**
 * Runs `fn` inside a savepoint and turns a unique-key violation into `undefined`, so a lost race on a business key is
 * a clean conflict result instead of an aborted transaction. Anything else is rethrown.
 */
export async function guardUnique<T>(tx: Tx, fn: (q: Tx) => Promise<T>): Promise<T | undefined> {
  try {
    return await tx.transaction(async sp => fn(sp as unknown as Tx))
  } catch (e) {
    if (isUniqueViolation(e)) return undefined
    throw e
  }
}

/* ---------------- loaders (each takes the lock the caller needs) ---------------- */

type Lock = 'update' | 'share' | false

export async function loadSite(tx: Tx, id: string, lock: Lock = false): Promise<SiteRow | undefined> {
  const q = tx.select().from(site).where(eq(site.id, id))
  return (lock ? (await q.for(lock === 'update' ? 'update' : 'share'))[0] : (await q)[0])
}
export async function loadBuilding(tx: Tx, id: string, lock: Lock = false): Promise<BuildingRow | undefined> {
  const q = tx.select().from(building).where(eq(building.id, id))
  return (lock ? (await q.for(lock === 'update' ? 'update' : 'share'))[0] : (await q)[0])
}
export async function loadRoom(tx: Tx, id: string, lock: Lock = false): Promise<RoomRow | undefined> {
  const q = tx.select().from(room).where(eq(room.id, id))
  return (lock ? (await q.for(lock === 'update' ? 'update' : 'share'))[0] : (await q)[0])
}
export async function loadBed(tx: Tx, id: string, lock: Lock = false): Promise<BedRow | undefined> {
  const q = tx.select().from(bed).where(eq(bed.id, id))
  return (lock ? (await q.for(lock === 'update' ? 'update' : 'share'))[0] : (await q)[0])
}

/** Active (not archived) rooms of a building, locked FOR UPDATE in a fixed order. */
export async function lockActiveRooms(tx: Tx, buildingId: string): Promise<RoomRow[]> {
  return tx.select().from(room).where(and(eq(room.buildingId, buildingId), isNull(room.archivedAt))).orderBy(asc(room.id)).for('update')
}
/** Active (not archived) beds of some rooms, locked FOR UPDATE in a fixed order. */
export async function lockActiveBeds(tx: Tx, roomIds: string[]): Promise<BedRow[]> {
  if (roomIds.length === 0) return []
  return tx.select().from(bed).where(and(inArray(bed.roomId, roomIds), isNull(bed.archivedAt))).orderBy(asc(bed.id)).for('update')
}

/** What goes into an audit row's before/after for each entity: small, stable and free of timestamps. */
export const snap = {
  site: (s: SiteRow) => ({ code: s.code, name: s.name, kind: s.kind, timeZone: s.timeZone }),
  building: (b: BuildingRow) => ({ siteId: b.siteId, code: b.code, name: b.name }),
  room: (r: RoomRow) => ({ siteId: r.siteId, buildingId: r.buildingId, floor: r.floor, unit: r.unit, name: r.name, genderPolicy: r.genderPolicy }),
  bed: (b: BedRow) => ({ siteId: b.siteId, roomId: b.roomId, code: b.code, state: b.state, reason: b.stateReason }),
}
