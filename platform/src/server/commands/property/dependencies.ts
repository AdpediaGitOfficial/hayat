/**
 * What stands in the way of archiving (or re-purposing) a bed, a room or a building (AT-029, D-19).
 *
 * The check is a LIST of small checker functions. Each one looks at the structure being archived and returns the
 * blockers it finds. Stages 2 to 4 add theirs by appending to DEPENDENCY_CHECKERS and nothing else changes:
 *   - Stage 2: outstanding keys and assets on the beds/rooms,
 *   - Stage 3: open cleaning / inspection tasks (today only the bed's own state is checked),
 *   - Stage 4: open work orders and contractor jobs.
 * The command runs the checkers INSIDE its transaction after taking row locks, so a reservation created concurrently
 * either committed first (and is seen here) or waits for the archive and is then refused by the database guard.
 * The same function powers the read-only preview the screens show before anybody clicks "Archive".
 */
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { bed, bedClaim, room } from '@/server/db/schema'
import type { Db } from '@/server/db/client'
import type { Tx } from '@/server/command/context'
import type { BedRow, RoomRow } from './shared'
import { loadBed, loadBuilding, loadRoom, lockActiveBeds, lockActiveRooms } from './shared'

export type StructureKind = 'bed' | 'room' | 'building'

export type BlockerKind =
  | 'occupied_bed'      // a resident lives there
  | 'live_claim'        // a reservation, offer hold or stay is on the books
  | 'bed_not_ready'     // cleaning / inspection / maintenance state still running
  | 'active_child'      // rooms or beds below it are still active (archive them first, or archive together)

export interface Blocker {
  kind: BlockerKind
  entityType: StructureKind
  entityId: string
  /** Short human label, for example "Bed PV-101-A (room 101)". */
  label: string
  why: string
  owner: string
  next: string
  /** Claim details, when the blocker is a claim: the first night and the departure day (end-exclusive, D-103). */
  claim?: { kind: 'reservation' | 'offer_hold' | 'stay'; from: string; to: string | null }
}

/** Everything a checker may need: the structure, its active descendants, and what the archive will do to children. */
export interface StructureScope {
  kind: StructureKind
  id: string
  siteId: string
  label: string
  /** The target itself is already archived. */
  archived: boolean
  rooms: RoomRow[]
  beds: BedRow[]
  /** Archive the active children together with the target instead of listing them as blockers. */
  cascade: boolean
}

type Q = Pick<Db, 'select'>
export type CheckFn = (q: Q, s: StructureScope) => Promise<Blocker[]>
export interface DependencyChecker {
  id: string
  /** True when the checker is about people (who lives or is booked there), as opposed to the physical structure. */
  people: boolean
  check: CheckFn
}

const bedLabel = (b: BedRow, rooms: Map<string, RoomRow>) => {
  const r = rooms.get(b.roomId)
  return r ? `Bed ${b.code} (room ${r.name})` : `Bed ${b.code}`
}

/* ---------------- loading the structure, with or without locks ---------------- */

/**
 * Loads the target and every ACTIVE descendant. With `lock`, takes FOR UPDATE on all of them in the fixed order
 * building -> rooms -> beds (inside a command's transaction). Without it, a plain read for previews.
 */
export async function loadStructure(
  q: Tx | Db, kind: StructureKind, id: string, opts: { lock: boolean; cascade: boolean },
): Promise<StructureScope | undefined> {
  const tx = q as Tx
  if (kind === 'bed') {
    const b = await loadBed(tx, id, opts.lock ? 'update' : false)
    if (!b) return undefined
    const r = await loadRoom(tx, b.roomId)
    return { kind, id, siteId: b.siteId, label: r ? `Bed ${b.code} (room ${r.name})` : `Bed ${b.code}`, archived: b.archivedAt !== null, rooms: r ? [r] : [], beds: [b], cascade: false }
  }
  if (kind === 'room') {
    const r = await loadRoom(tx, id, opts.lock ? 'update' : false)
    if (!r) return undefined
    const beds = opts.lock
      ? await lockActiveBeds(tx, [r.id])
      : await tx.select().from(bed).where(and(eq(bed.roomId, r.id), isNull(bed.archivedAt))).orderBy(asc(bed.code))
    return { kind, id, siteId: r.siteId, label: `Room ${r.name}`, archived: r.archivedAt !== null, rooms: [r], beds, cascade: opts.cascade }
  }
  const b = await loadBuilding(tx, id, opts.lock ? 'update' : false)
  if (!b) return undefined
  const rooms = opts.lock
    ? await lockActiveRooms(tx, b.id)
    : await tx.select().from(room).where(and(eq(room.buildingId, b.id), isNull(room.archivedAt))).orderBy(asc(room.name))
  const beds = opts.lock
    ? await lockActiveBeds(tx, rooms.map(r => r.id))
    : rooms.length ? await tx.select().from(bed).where(and(inArray(bed.roomId, rooms.map(r => r.id)), isNull(bed.archivedAt))).orderBy(asc(bed.code)) : []
  return { kind, id, siteId: b.siteId, label: `Building ${b.name}`, archived: b.archivedAt !== null, rooms, beds, cascade: opts.cascade }
}

/* ---------------- the checkers ---------------- */

const occupiedBeds: CheckFn = async (_q, s) => {
  const rooms = new Map(s.rooms.map(r => [r.id, r]))
  return s.beds.filter(b => b.state === 'occupied').map(b => ({
    kind: 'occupied_bed' as const, entityType: 'bed' as const, entityId: b.id, label: bedLabel(b, rooms),
    why: 'A resident is staying in this bed.',
    owner: 'Accommodation Admin',
    next: 'Check the resident out or transfer them to another bed, then try again.',
  }))
}

/** Cleaning, inspection and maintenance: the bed's own state until Stages 3 and 4 add their task/work-order checkers. */
const notReadyBeds: CheckFn = async (_q, s) => {
  const rooms = new Map(s.rooms.map(r => [r.id, r]))
  const next: Record<string, [string, string, string]> = {
    needs_cleaning: ['The bed is waiting to be cleaned.', 'Housekeeping', 'Finish cleaning and the final inspection, then try again.'],
    inspection_required: ['The bed is waiting for its final inspection.', 'Final Inspection holder', 'Complete the final inspection, then try again.'],
    under_maintenance: ['Maintenance work is still open on this bed.', 'Maintenance Coordinator', 'Finish or cancel the work, then try again.'],
  }
  return s.beds.filter(b => next[b.state]).map(b => ({
    kind: 'bed_not_ready' as const, entityType: 'bed' as const, entityId: b.id, label: bedLabel(b, rooms),
    why: next[b.state][0], owner: next[b.state][1], next: next[b.state][2],
  }))
}

/** Reservations, bed-offer holds and stays that are still live (not released). A future booking counts as much as a current stay. */
const liveClaims: CheckFn = async (q, s) => {
  if (s.beds.length === 0) return []
  const rooms = new Map(s.rooms.map(r => [r.id, r]))
  const byId = new Map(s.beds.map(b => [b.id, b]))
  const rows = await q.select({
    bedId: bedClaim.bedId, kind: bedClaim.kind,
    from: sql<string>`lower(${bedClaim.period})::text`, to: sql<string | null>`upper(${bedClaim.period})::text`,
  }).from(bedClaim).where(and(inArray(bedClaim.bedId, s.beds.map(b => b.id)), isNull(bedClaim.releasedAt))).orderBy(asc(bedClaim.bedId), sql`lower(${bedClaim.period})`)
  const out: Blocker[] = []
  for (const c of rows) {
    const b = byId.get(c.bedId)!
    // An occupied bed is already reported once as occupied; do not list the same resident twice.
    if (c.kind === 'stay' && b.state === 'occupied') continue
    const what = c.kind === 'stay' ? ['A stay is still open on this bed.', 'Check the resident out or transfer them, then try again.']
      : c.kind === 'offer_hold' ? ['The bed is held for a pending bed offer.', 'Withdraw the offer, or let the person answer it, then try again.']
      : ['A reservation is booked on this bed.', 'Cancel the reservation or move it to another bed, then try again.']
    out.push({
      kind: 'live_claim', entityType: 'bed', entityId: b.id, label: bedLabel(b, rooms),
      why: `${what[0]} (${c.from}${c.to ? ` to ${c.to}, departure day` : ' onward, open-ended'})`,
      owner: 'Accommodation Admin', next: what[1],
      claim: { kind: c.kind, from: c.from, to: c.to },
    })
  }
  return out
}

/** Rooms/beds below the target that are still active. Skipped when the archive will take them along (cascade). */
const activeChildren: CheckFn = async (_q, s) => {
  if (s.cascade) return []
  if (s.kind === 'room') {
    return s.beds.map(b => ({
      kind: 'active_child' as const, entityType: 'bed' as const, entityId: b.id, label: `Bed ${b.code}`,
      why: 'The bed is still active in this room.', owner: 'Accommodation Admin',
      next: 'Archive the bed first, or archive the room together with its beds.',
    }))
  }
  if (s.kind === 'building') {
    return s.rooms.map(r => ({
      kind: 'active_child' as const, entityType: 'room' as const, entityId: r.id, label: `Room ${r.name}`,
      why: 'The room is still active in this building.', owner: 'Accommodation Admin',
      next: 'Archive the room first, or archive the building together with its rooms and beds.',
    }))
  }
  return []
}

/**
 * Append a checker here to add a dependency (outstanding key, open work order, ...). Order is the order they are listed
 * in the answer: what makes the structure unusable first, bookkeeping last.
 */
export const DEPENDENCY_CHECKERS: DependencyChecker[] = [
  { id: 'occupied_beds', people: true, check: occupiedBeds },
  { id: 'live_claims', people: true, check: liveClaims },
  { id: 'beds_not_ready', people: false, check: notReadyBeds },
  { id: 'active_children', people: false, check: activeChildren },
]

/** Hard ceiling for what one answer carries; the real count is reported alongside. */
export const MAX_BLOCKERS_LISTED = 100

export interface BlockerReport { blockers: Blocker[]; total: number; truncated: boolean }

export async function findBlockers(q: Q, s: StructureScope, checkers: DependencyChecker[] = DEPENDENCY_CHECKERS): Promise<BlockerReport> {
  const all: Blocker[] = []
  for (const c of checkers) all.push(...await c.check(q, s))
  return { blockers: all.slice(0, MAX_BLOCKERS_LISTED), total: all.length, truncated: all.length > MAX_BLOCKERS_LISTED }
}

/** "2 occupied beds, 1 live reservation": the one-line reason above the list. */
export function summarize(report: BlockerReport): string {
  const n = (k: BlockerKind) => report.blockers.filter(b => b.kind === k).length
  const parts: string[] = []
  const add = (count: number, one: string, many: string) => { if (count) parts.push(`${count} ${count === 1 ? one : many}`) }
  add(n('occupied_bed'), 'occupied bed', 'occupied beds')
  add(n('live_claim'), 'live reservation, hold or stay', 'live reservations, holds or stays')
  add(n('bed_not_ready'), 'bed still being cleaned, inspected or repaired', 'beds still being cleaned, inspected or repaired')
  add(n('active_child'), 'active item below it', 'active items below it')
  const text = parts.join(', ')
  return report.truncated ? `${text} (first ${MAX_BLOCKERS_LISTED} of ${report.total} listed)` : text
}
