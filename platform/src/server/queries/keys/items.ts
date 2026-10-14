/**
 * Reading keys and assets (WP-I). Every query is scoped in SQL through scopeSql: Reception and the administrators see the items
 * of their sites, a Night Keys holder the cabinet of theirs, a Resident only the items they hold (`keys.view` own), and nobody
 * another resident's. Overdue is computed here from the rules in ./overdue, never stored.
 */
import { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { bed, building, room, site, staffProfile, stay, userAccount } from '@/server/db/schema'
import { handoverEvent, handoverItem, type HandoverEventKind, type HandoverStatus } from '@/server/db/schema.stage3'
import { getDb, type Db } from '@/server/db/client'
import { getConfig } from '@/server/config/registry'
import { decide, scopeFilter, type Actor, type ScopeFilter } from '@/server/policy'
import { scopeSql } from '@/server/queries/scope'
import { isUuid } from '@/server/commands/property/shared'
import { listAttachments, type AttachmentView } from '@/server/attachments'
import { getClock } from '@/server/runtime'
import { holdabilityProblem, KEY_ACTIONS, MOVE_ACTIONS } from '@/server/commands/keys/shared'
import { loadHolderFacts, NOT_OVERDUE, overdueState, type HolderFacts, type Overdue } from './overdue'

type Reader = Pick<Db, 'select'>

/* ---------------- scope ---------------- */

/** The rows the actor may see: the union of every keys action they hold (view, manage, issue and return, night keys). */
export function keysScope(actor: Actor): ScopeFilter {
  const sites = new Set<string>()
  let owner: string | undefined
  for (const a of KEY_ACTIONS) {
    const f = scopeFilter(actor, a)
    if (f.kind === 'all') return f
    if (f.kind === 'restricted') { f.siteIds.forEach(s => sites.add(s)); owner = owner ?? f.ownerStaffId }
  }
  return sites.size || owner ? { kind: 'restricted', siteIds: [...sites], ownerStaffId: owner } : { kind: 'none' }
}
export const canUseKeys = (actor: Actor) => keysScope(actor).kind !== 'none'
/** May the actor hand items out and take them back anywhere at all (a menu question; the commands check the site)? */
export const canMoveKeys = (actor: Actor) => MOVE_ACTIONS.some(a => decide(actor, a).allowed)
const itemScope = (actor: Actor) => scopeSql(keysScope(actor), { site: handoverItem.siteId, owner: handoverItem.holderStaffId })

export interface Abilities { move: boolean; manage: boolean }
export function abilitiesAt(actor: Actor, siteId: string): Abilities {
  return { move: MOVE_ACTIONS.some(a => decide(actor, a, { siteId }).allowed), manage: decide(actor, 'keys.manage', { siteId }).allowed }
}

/* ---------------- rows ---------------- */

export interface HolderView { id: string; name: string; employeeId: string; left: boolean }
export interface ItemRow {
  id: string
  category: 'key' | 'asset'
  itemType: string
  itemTypeLabel: string
  code: string
  siteId: string
  siteName: string
  roomId: string | null
  bedId: string | null
  /** "Room 12" or "Palm Villas › Block A › Room 12 › Bed A": what the item belongs to. */
  forLabel: string | null
  status: HandoverStatus
  holder: HolderView | null
  issuedAt: string | null
  dueBack: string | null
  replacedBy: { id: string; code: string } | null
  replaces: { id: string; code: string } | null
  note: string | null
  archived: boolean
  overdue: Overdue
  /**
   * Did the latest movement of this item happen outside the site's key desk office hours? (P-03, proposed, pending client sign-off.)
   * A fact for staff; never shown to a resident, and false for an item with no movement yet.
   */
  lastAfterHours: boolean
}

export interface ItemFilters {
  siteId?: string; status?: HandoverStatus | 'outstanding'; staffId?: string; bedId?: string; roomId?: string; category?: 'key' | 'asset'
  /** Exact code (case-insensitive), as typed or scanned at the desk. */
  code?: string
  /** Part of a code, or of the holder's name or employee ID. */
  q?: string
  overdue?: boolean
  /** Only items whose latest movement was outside office hours (the desk list filter "Out of hours"). */
  afterHours?: boolean
  includeArchived?: boolean
  limit?: number; offset?: number
}

const escapeLike = (s: string) => s.replace(/[%_\\]/g, m => '\\' + m)

async function toRows(db: Reader, actor: Actor, raw: (typeof handoverItem.$inferSelect)[], now: Date): Promise<ItemRow[]> {
  if (raw.length === 0) return []
  const types = new Map((await getConfig(db, 'keys.item_types')).map(t => [t.id, t.label]))
  const grace = await getConfig(db, 'keys.overdue_grace_days')
  const sites = new Map((await db.select({ id: site.id, name: site.name, tz: site.timeZone }).from(site).where(inArray(site.id, [...new Set(raw.map(r => r.siteId))]))).map(s => [s.id, s]))
  const bedIds = [...new Set(raw.map(r => r.bedId).filter((x): x is string => !!x))]
  const roomIds = [...new Set(raw.map(r => r.roomId).filter((x): x is string => !!x))]
  const beds = new Map<string, string>()
  if (bedIds.length) {
    const rows = await db.select({ id: bed.id, code: bed.code, room: room.name, building: building.name }).from(bed).innerJoin(room, eq(room.id, bed.roomId)).leftJoin(building, eq(building.id, room.buildingId)).where(inArray(bed.id, bedIds))
    for (const b of rows) beds.set(b.id, [b.building, b.room, `Bed ${b.code}`].filter(Boolean).join(' › '))
  }
  const rooms = new Map<string, string>()
  if (roomIds.length) {
    const rows = await db.select({ id: room.id, name: room.name, building: building.name }).from(room).leftJoin(building, eq(building.id, room.buildingId)).where(inArray(room.id, roomIds))
    for (const r of rows) rooms.set(r.id, [r.building, r.name].filter(Boolean).join(' › '))
  }
  const holderIds = raw.map(r => r.holderStaffId).filter((x): x is string => !!x)
  const people = new Map<string, { name: string; employeeId: string }>()
  if (holderIds.length) for (const p of await db.select({ id: staffProfile.id, name: staffProfile.fullName, employeeId: staffProfile.employeeId }).from(staffProfile).where(inArray(staffProfile.id, holderIds))) people.set(p.id, p)
  const facts = await loadHolderFacts(db, holderIds)
  // The latest movement of each item: was it outside office hours? Only staff see this (a resident sees what happened, not the desk's own control facts).
  const scope = keysScope(actor)
  const staffView = scope.kind === 'all' || (scope.kind === 'restricted' && scope.siteIds.length > 0)
  const lastAfter = new Map<string, boolean>()
  if (staffView) {
    const latest = await db.select({ itemId: handoverEvent.itemId, afterHours: sql<boolean>`(array_agg(${handoverEvent.afterHours} order by ${handoverEvent.createdAt} desc, ${handoverEvent.id} desc))[1]` })
      .from(handoverEvent).where(inArray(handoverEvent.itemId, raw.map(r => r.id))).groupBy(handoverEvent.itemId)
    for (const e of latest) lastAfter.set(e.itemId, e.afterHours)
  }
  const links = [...new Set(raw.map(r => r.replacedBy).filter((x): x is string => !!x))]
  const replacedBy = new Map<string, string>()
  if (links.length) for (const r of await db.select({ id: handoverItem.id, code: handoverItem.code }).from(handoverItem).where(inArray(handoverItem.id, links))) replacedBy.set(r.id, r.code)
  const replaces = new Map<string, { id: string; code: string }>()
  const replacing = await db.select({ id: handoverItem.id, code: handoverItem.code, by: handoverItem.replacedBy }).from(handoverItem).where(inArray(handoverItem.replacedBy, raw.map(r => r.id)))
  for (const r of replacing) if (r.by) replaces.set(r.by, { id: r.id, code: r.code })

  return raw.map(r => {
    const s = sites.get(r.siteId)!
    const p = r.holderStaffId ? people.get(r.holderStaffId) : undefined
    const f: HolderFacts | undefined = r.holderStaffId ? facts.get(r.holderStaffId) : undefined
    const forLabel = r.bedId ? beds.get(r.bedId) ?? null : r.roomId ? rooms.get(r.roomId) ?? null : null
    return {
      id: r.id, category: r.category, itemType: r.itemType, itemTypeLabel: types.get(r.itemType) ?? r.itemType.replace(/_/g, ' '), code: r.code,
      siteId: r.siteId, siteName: s.name, roomId: r.roomId, bedId: r.bedId, forLabel, status: r.status,
      holder: r.holderStaffId && p ? { id: r.holderStaffId, name: p.name, employeeId: p.employeeId, left: f?.left ?? false } : null,
      issuedAt: r.issuedAt?.toISOString() ?? null, dueBack: r.dueBack, replacedBy: r.replacedBy ? { id: r.replacedBy, code: replacedBy.get(r.replacedBy) ?? '' } : null,
      replaces: replaces.get(r.id) ?? null, note: r.note, archived: !!r.archivedAt, lastAfterHours: lastAfter.get(r.id) ?? false,
      overdue: overdueState({ status: r.status, dueBack: r.dueBack, timeZone: s.tz, now, graceDays: grace, holder: f }),
    } satisfies ItemRow
  })
}

/** Items the actor may see, most urgent first (overdue, then lost and damaged, then issued, then the cabinet). */
export async function listItems(actor: Actor, f: ItemFilters = {}, now: Date = getClock().now()): Promise<{ rows: ItemRow[]; total: number }> {
  const db = getDb()
  const q = f.q?.trim()
  const raw = await db.select({ item: handoverItem }).from(handoverItem)
    .leftJoin(staffProfile, eq(staffProfile.id, handoverItem.holderStaffId))
    .where(and(
      itemScope(actor),
      f.includeArchived ? undefined : isNull(handoverItem.archivedAt),
      f.siteId ? eq(handoverItem.siteId, f.siteId) : undefined,
      f.status === 'outstanding' ? inArray(handoverItem.status, ['issued', 'lost', 'damaged']) : f.status ? eq(handoverItem.status, f.status) : undefined,
      f.staffId ? eq(handoverItem.holderStaffId, f.staffId) : undefined,
      f.bedId ? eq(handoverItem.bedId, f.bedId) : undefined,
      f.roomId ? eq(handoverItem.roomId, f.roomId) : undefined,
      f.category ? eq(handoverItem.category, f.category) : undefined,
      f.code ? sql`lower(btrim(${handoverItem.code})) = ${f.code.trim().toLowerCase()}` : undefined,
      q ? or(sql`${handoverItem.code} ilike ${'%' + escapeLike(q) + '%'}`, sql`${staffProfile.fullName} ilike ${'%' + escapeLike(q) + '%'}`, sql`${staffProfile.employeeId} ilike ${'%' + escapeLike(q) + '%'}`) : undefined,
    )).orderBy(asc(handoverItem.siteId), asc(handoverItem.code)).limit(2000)
  let rows = await toRows(db, actor, raw.map(r => r.item), now)
  if (f.overdue) rows = rows.filter(r => r.overdue.overdue)
  if (f.afterHours) rows = rows.filter(r => r.lastAfterHours)
  const rank = (r: ItemRow) => r.overdue.overdue ? 0 : r.status === 'lost' || r.status === 'damaged' ? 1 : r.status === 'issued' ? 2 : r.status === 'in_cabinet' ? 3 : 4
  rows.sort((a, b) => rank(a) - rank(b) || (b.overdue.daysOver - a.overdue.daysOver) || a.siteName.localeCompare(b.siteName) || a.code.localeCompare(b.code))
  const total = rows.length
  return { rows: rows.slice(f.offset ?? 0, (f.offset ?? 0) + (f.limit ?? 100)), total }
}

/* ---------------- detail and history ---------------- */

export interface EventView { id: string; kind: HandoverEventKind; at: string; person: { name: string; employeeId: string } | null; actor: string | null; onBehalf: boolean; note: string | null; afterHours: boolean }
export interface ItemDetail extends ItemRow { events: EventView[]; attachments: AttachmentView[]; abilities: Abilities }

/** One item and its history, or undefined when it does not exist or is not the actor's to see (the same answer, AT-001). */
export async function getItemDetail(actor: Actor, id: string, now: Date = getClock().now()): Promise<ItemDetail | undefined> {
  if (!isUuid(id)) return undefined
  const db = getDb()
  const raw = await db.select().from(handoverItem).where(and(eq(handoverItem.id, id), itemScope(actor))).limit(1)
  if (raw.length === 0) return undefined
  const [row] = await toRows(db, actor, raw, now)
  const actorStaff = alias(staffProfile, 'actor_staff')
  const evs = await db.select({
    id: handoverEvent.id, kind: handoverEvent.kind, at: handoverEvent.createdAt, onBehalf: handoverEvent.onBehalf, note: handoverEvent.note, afterHours: handoverEvent.afterHours,
    pName: staffProfile.fullName, pEmp: staffProfile.employeeId, actorName: actorStaff.fullName, actorUser: userAccount.username,
  }).from(handoverEvent)
    .leftJoin(staffProfile, eq(staffProfile.id, handoverEvent.staffId))
    .leftJoin(userAccount, eq(userAccount.id, handoverEvent.actorUserId))
    .leftJoin(actorStaff, eq(actorStaff.id, userAccount.staffId))
    .where(eq(handoverEvent.itemId, id)).orderBy(desc(handoverEvent.createdAt), desc(handoverEvent.id))
  const own = !abilitiesAt(actor, row.siteId).move && !decide(actor, 'keys.view', { siteId: row.siteId }).allowed   // a resident: what happened, not who did it
  const events: EventView[] = evs.map(e => ({
    id: e.id, kind: e.kind, at: e.at.toISOString(), person: e.pName ? { name: e.pName, employeeId: e.pEmp ?? '' } : null,
    actor: own ? null : e.actorName ?? e.actorUser ?? 'System', onBehalf: e.onBehalf, note: e.note, afterHours: own ? false : e.afterHours,
  }))
  return { ...row, events, attachments: await listAttachments(db, actor, 'handover_item', id), abilities: abilitiesAt(actor, row.siteId) }
}

/* ---------------- a person looked up at the desk ---------------- */

export interface KeyPerson { id: string; employeeId: string; fullName: string; department: string | null; employmentStatus: 'active' | 'left'; isSelf: boolean; canHold: boolean; problem: string | null }

/**
 * Exact employee ID (the business key). Only those who hand items out may look a person up, and only the minimum they need: name,
 * department, whether they are active, and whether this item may be given to them (so the screen can say why not before asking).
 */
export async function findKeyPerson(actor: Actor, employeeId: string, itemId?: string): Promise<KeyPerson | undefined> {
  if (!canMoveKeys(actor)) return undefined
  const key = employeeId.trim().toLowerCase()
  if (!key) return undefined
  const db = getDb()
  const [p] = await db.select({ id: staffProfile.id, employeeId: staffProfile.employeeId, fullName: staffProfile.fullName, department: staffProfile.department, status: staffProfile.employmentStatus, archivedAt: staffProfile.archivedAt })
    .from(staffProfile).where(and(sql`lower(btrim(${staffProfile.employeeId})) = ${key}`, isNull(staffProfile.archivedAt))).limit(1)
  if (!p) return undefined
  let problem: string | null = null
  if (itemId && isUuid(itemId)) {
    const [item] = await db.select().from(handoverItem).where(and(eq(handoverItem.id, itemId), itemScope(actor))).limit(1)
    if (item) problem = (await holdabilityProblem(db, item, { status: p.status, archivedAt: p.archivedAt, name: p.fullName }, p.id))?.reason ?? null
  }
  const isSelf = actor.staffId === p.id
  if (isSelf) problem = 'You cannot issue a key or asset to yourself. Another member of staff must do it'
  return { id: p.id, employeeId: p.employeeId, fullName: p.fullName, department: p.department, employmentStatus: p.status, isSelf, canHold: !problem, problem }
}

/* ---------------- keys for a stay, and after a transfer ---------------- */

/** The rows held by a person that belong to somewhere other than the stay's current bed and room. */
function splitHeld(rows: ItemRow[], current: { bedId: string; roomId: string }) {
  const here: ItemRow[] = [], toSwap: ItemRow[] = [], unlinked: ItemRow[] = []
  for (const r of rows) {
    if (r.bedId) (r.bedId === current.bedId ? here : toSwap).push(r)
    else if (r.roomId) (r.roomId === current.roomId ? here : toSwap).push(r)
    else unlinked.push(r)
  }
  return { here, toSwap, unlinked }
}

async function stayInfo(db: Reader, stayId: string) {
  const [s] = await db.select({ id: stay.id, staffId: stay.staffId, staffName: staffProfile.fullName, bedId: stay.bedId, status: stay.status, siteId: bed.siteId, roomId: bed.roomId, bedCode: bed.code, roomName: room.name })
    .from(stay).innerJoin(staffProfile, eq(staffProfile.id, stay.staffId)).innerJoin(bed, eq(bed.id, stay.bedId)).innerJoin(room, eq(room.id, bed.roomId)).where(eq(stay.id, stayId)).limit(1)
  return s
}

/**
 * After a transfer or swap the person still holds the keys of the bed (or room) they left. Those are the keys to return and
 * reissue (D-61): items issued to them whose bed is not their current bed, or whose room is not their current room.
 * Scoped like every other read: an item the actor cannot see is not listed.
 */
export async function keysToSwapForStay(stayId: string, actor: Actor, now: Date = getClock().now()): Promise<ItemRow[]> {
  if (!isUuid(stayId)) return []
  const db = getDb()
  const s = await stayInfo(db, stayId)
  if (!s) return []
  const raw = await db.select().from(handoverItem).where(and(eq(handoverItem.holderStaffId, s.staffId), eq(handoverItem.status, 'issued'), isNull(handoverItem.archivedAt), itemScope(actor)))
  return splitHeld(await toRows(db, actor, raw, now), s).toSwap
}

export interface StayKeys {
  stayId: string; staffId: string; staffName: string; siteId: string; bedCode: string; roomName: string
  /** Held by the person and belonging to this bed or room. */
  here: ItemRow[]
  /** Held by the person, belonging to another bed or room: to return and reissue after a transfer. */
  toSwap: ItemRow[]
  /** Held by the person, not tied to any bed or room (an access card). */
  unlinked: ItemRow[]
  /** In the cabinet for this bed or room: can be issued now. */
  available: ItemRow[]
  abilities: Abilities
}

/** Everything the stay page needs about keys. Undefined when the actor has no keys access at the stay's site. */
export async function keysForStay(actor: Actor, stayId: string, now: Date = getClock().now()): Promise<StayKeys | undefined> {
  if (!isUuid(stayId)) return undefined
  const db = getDb()
  const s = await stayInfo(db, stayId)
  if (!s) return undefined
  const mine = actor.staffId === s.staffId
  if (!KEY_ACTIONS.some(a => decide(actor, a, { siteId: s.siteId, ownerStaffId: s.staffId }).allowed)) return undefined
  const held = await db.select().from(handoverItem).where(and(
    eq(handoverItem.holderStaffId, s.staffId), inArray(handoverItem.status, ['issued', 'lost', 'damaged']), isNull(handoverItem.archivedAt), itemScope(actor)))
  const split = splitHeld(await toRows(db, actor, held, now), s)
  const ab = abilitiesAt(actor, s.siteId)
  const cabinet = ab.move && !mine
    ? await db.select().from(handoverItem).where(and(
      eq(handoverItem.status, 'in_cabinet'), isNull(handoverItem.archivedAt), eq(handoverItem.siteId, s.siteId), itemScope(actor),
      or(eq(handoverItem.bedId, s.bedId), and(eq(handoverItem.roomId, s.roomId), isNull(handoverItem.bedId))))).orderBy(asc(handoverItem.code))
    : []
  return { stayId: s.id, staffId: s.staffId, staffName: s.staffName, siteId: s.siteId, bedCode: s.bedCode, roomName: s.roomName, ...split, available: await toRows(db, actor, cabinet, now), abilities: ab }
}

/** What the signed-in person holds (the /my section). Own items only, whatever else the role could see. */
export async function myKeys(actor: Actor, now: Date = getClock().now()): Promise<ItemRow[]> {
  if (!actor.staffId) return []
  const db = getDb()
  const raw = await db.select().from(handoverItem).where(and(eq(handoverItem.holderStaffId, actor.staffId), inArray(handoverItem.status, ['issued', 'lost', 'damaged']), isNull(handoverItem.archivedAt), itemScope(actor)))
  return toRows(db, actor, raw, now)
}

/* ---------------- screens: sites and places to link an item to ---------------- */

export interface LinkOptions { sites: { id: string; name: string }[]; rooms: { id: string; siteId: string; label: string }[]; beds: { id: string; siteId: string; label: string }[] }

/** Sites the actor manages keys at, and the active rooms and beds there (for the "belongs to" pickers). */
export async function linkOptions(actor: Actor): Promise<LinkOptions> {
  const db = getDb()
  const where = scopeSql(scopeFilter(actor, 'keys.manage'), { site: site.id })
  const sites = await db.select({ id: site.id, name: site.name }).from(site).where(and(where, isNull(site.archivedAt))).orderBy(asc(site.name))
  if (sites.length === 0) return { sites: [], rooms: [], beds: [] }
  const ids = sites.map(s => s.id)
  const rooms = await db.select({ id: room.id, siteId: room.siteId, name: room.name, building: building.name }).from(room).leftJoin(building, eq(building.id, room.buildingId))
    .where(and(inArray(room.siteId, ids), isNull(room.archivedAt))).orderBy(asc(room.name)).limit(2000)
  const beds = await db.select({ id: bed.id, siteId: bed.siteId, code: bed.code, room: room.name, building: building.name }).from(bed).innerJoin(room, eq(room.id, bed.roomId)).leftJoin(building, eq(building.id, room.buildingId))
    .where(and(inArray(bed.siteId, ids), isNull(bed.archivedAt), isNull(room.archivedAt))).orderBy(asc(room.name), asc(bed.code)).limit(4000)
  return {
    sites,
    rooms: rooms.map(r => ({ id: r.id, siteId: r.siteId, label: [r.building, r.name].filter(Boolean).join(' › ') })),
    beds: beds.map(b => ({ id: b.id, siteId: b.siteId, label: [b.building, b.room, `Bed ${b.code}`].filter(Boolean).join(' › ') })),
  }
}
