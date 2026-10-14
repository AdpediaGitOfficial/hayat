/**
 * Loaders and small steps shared by the exit commands (Mark as Left, clearance work, rehire) and the queries.
 * Everything takes the caller's transaction or reader; nothing here opens its own.
 */
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { bed, bedClaim, reservation, site, staffProfile, stay, userAccount, roleAssignment } from '@/server/db/schema'
import { attachment, handoverEvent, handoverItem } from '@/server/db/schema.stage3'
import { clearanceCase, clearanceEvent, clearanceItem, type ClearanceEventKind, type ClearanceOwner } from '@/server/db/schema.exit'
import type { Db } from '@/server/db/client'
import type { Tx } from '@/server/command/context'
import { authorize } from '@/server/command/authorize'
import { fail, type Failure } from '@/server/command/result'
import { getConfig } from '@/server/config/registry'
import { scopeFilter, type Action, type Actor } from '@/server/policy'
import { outstandingHandovers } from '@/server/handover/outstanding'
import { OCCUPYING_STAY_STATUSES } from '@/domain/enums'
import { deriveCaseStatus, effectiveStatus, effectiveOwner, isLostOrDamaged, type ItemFacts } from './rules'

export { idSchema, reasonSchema, isUuid, todayInZone } from '@/server/commands/property/shared'

type Reader = Pick<Db, 'select'>
export type CaseRow = typeof clearanceCase.$inferSelect
export type ItemRow = typeof clearanceItem.$inferSelect

export const OPEN_CASE_STATUSES = ['open', 'in_progress', 'pending_items'] as const

/* ---------------- who the exit is about, and where ---------------- */

export interface PersonFacts {
  staffId: string
  employeeId: string
  fullName: string
  employmentStatus: 'active' | 'left'
  archivedAt: Date | null
  leftAt: Date | null
  leftEffective: string | null
  userId: string | null
  accountStatus: 'invited' | 'active' | 'locked' | 'revoked' | null
}

export async function loadPerson(q: Reader, staffId: string, lock = false): Promise<PersonFacts | undefined> {
  const base = q.select({
    staffId: staffProfile.id, employeeId: staffProfile.employeeId, fullName: staffProfile.fullName, employmentStatus: staffProfile.employmentStatus,
    archivedAt: staffProfile.archivedAt, leftAt: staffProfile.leftAt, leftEffective: staffProfile.leftEffective,
    userId: userAccount.id, accountStatus: userAccount.status,
  }).from(staffProfile).leftJoin(userAccount, eq(userAccount.staffId, staffProfile.id)).where(eq(staffProfile.id, staffId)).limit(1)
  const [r] = lock ? await base.for('update', { of: staffProfile }) : await base
  return r
}

export interface StaySummary { id: string; status: 'provisional' | 'active' | 'resolution_pending' | 'checked_out' | 'closed'; bedId: string; bedCode: string; bedState: string; siteId: string; siteName: string; roomName?: string }

/** The stay an exit concerns: the one the person is in; failing that, the latest stay that is checked out and not yet closed. */
export async function exitStay(q: Reader, staffId: string, lock = false): Promise<StaySummary | undefined> {
  const cols = { id: stay.id, status: stay.status, bedId: stay.bedId, bedCode: bed.code, bedState: bed.state, siteId: bed.siteId, siteName: site.name }
  const live = q.select(cols).from(stay).innerJoin(bed, eq(bed.id, stay.bedId)).innerJoin(site, eq(site.id, bed.siteId))
    .where(and(eq(stay.staffId, staffId), inArray(stay.status, [...OCCUPYING_STAY_STATUSES]), isNull(stay.archivedAt))).limit(1)
  const [a] = lock ? await live.for('update', { of: stay }) : await live
  if (a) return a as StaySummary
  const [b] = await q.select(cols).from(stay).innerJoin(bed, eq(bed.id, stay.bedId)).innerJoin(site, eq(site.id, bed.siteId))
    .where(and(eq(stay.staffId, staffId), eq(stay.status, 'checked_out'), isNull(stay.archivedAt))).orderBy(desc(stay.checkedInAt)).limit(1)
  return b as StaySummary | undefined
}

export interface FutureReservation { id: string; claimId: string; bedId: string; bedCode: string; siteId: string; from: string; to: string | null }

export async function futureReservations(q: Reader, staffId: string, lock = false): Promise<FutureReservation[]> {
  const base = q.select({
    id: reservation.id, claimId: reservation.claimId, bedId: reservation.bedId, bedCode: bed.code, siteId: bed.siteId,
    from: sql<string>`lower(${bedClaim.period})::text`, to: sql<string | null>`upper(${bedClaim.period})::text`,
  }).from(reservation).innerJoin(bed, eq(bed.id, reservation.bedId)).innerJoin(bedClaim, eq(bedClaim.id, reservation.claimId))
    .where(and(eq(reservation.staffId, staffId), eq(reservation.status, 'reserved'))).orderBy(asc(reservation.id))
  return lock ? base.for('update', { of: reservation }) : base
}

/**
 * The site of the exit: where the person's live stay is, or failing that where a reservation is. A person with neither has no
 * site, so any holder of the action may act (S-8: the staff directory has no site column; documented, not hidden).
 */
export async function exitSiteId(q: Reader, staffId: string): Promise<string | undefined> {
  const s = await exitStay(q, staffId)
  if (s) return s.siteId
  return (await futureReservations(q, staffId))[0]?.siteId
}

/** Authorizes an action against a site, or, for a case with no site, for anyone who holds the action with any usable scope. */
export function authorizeAtSite(c: { actor: Actor }, action: Action, siteId: string | null | undefined): Failure | undefined {
  if (siteId) return authorize(c, action, { siteId })
  const denied = authorize(c, action)
  if (denied) return denied
  if (scopeFilter(c.actor, action).kind === 'none') return fail.forbidden('do this because no site is assigned to you', 'Super Admin')
  return undefined
}

/** Does this account hold a Super Admin assignment (active)? */
export async function holdsSuperAdmin(q: Reader, userId: string): Promise<boolean> {
  const r = await q.select({ id: roleAssignment.id }).from(roleAssignment)
    .where(and(eq(roleAssignment.userId, userId), eq(roleAssignment.role, 'SA'), isNull(roleAssignment.revokedAt))).limit(1)
  return r.length > 0
}

/* ---------------- cases and items ---------------- */

export async function loadCase(q: Reader, id: string): Promise<CaseRow | undefined> {
  return (await q.select().from(clearanceCase).where(eq(clearanceCase.id, id)).limit(1))[0]
}
export async function loadCaseLocked(tx: Tx, id: string): Promise<CaseRow | undefined> {
  return (await tx.select().from(clearanceCase).where(eq(clearanceCase.id, id)).limit(1).for('update'))[0]
}
/** The person's latest case (open first, then the most recent), or undefined. */
export async function latestCaseFor(q: Reader, staffId: string): Promise<CaseRow | undefined> {
  const [open] = await q.select().from(clearanceCase).where(and(eq(clearanceCase.staffId, staffId), inArray(clearanceCase.status, [...OPEN_CASE_STATUSES]))).limit(1)
  if (open) return open
  return (await q.select().from(clearanceCase).where(eq(clearanceCase.staffId, staffId)).orderBy(desc(clearanceCase.openedAt)).limit(1))[0]
}

export interface LiveHandover { status: typeof handoverItem.$inferSelect.status; holderStaffId: string | null; code: string; itemType: string; category: 'key' | 'asset'; roomId: string | null; bedId: string | null }
export type ItemWithLive = ItemRow & { live?: LiveHandover }

/** The case's items with the register's current state for every key or asset item. */
export async function caseItems(q: Reader, caseId: string, lock = false): Promise<ItemWithLive[]> {
  const base = q.select({ item: clearanceItem, live: { status: handoverItem.status, holderStaffId: handoverItem.holderStaffId, code: handoverItem.code, itemType: handoverItem.itemType, category: handoverItem.category, roomId: handoverItem.roomId, bedId: handoverItem.bedId } })
    .from(clearanceItem).leftJoin(handoverItem, eq(handoverItem.id, clearanceItem.handoverItemId))
    .where(eq(clearanceItem.caseId, caseId)).orderBy(asc(clearanceItem.position), asc(clearanceItem.id))
  const rows = lock ? await base.for('update', { of: clearanceItem }) : await base
  return rows.map(r => ({ ...r.item, live: r.item.kind === 'handover' && r.live?.status ? (r.live as LiveHandover) : undefined }))
}

export const factsOf = (i: ItemWithLive): ItemFacts => ({ kind: i.kind, mandatory: i.mandatory, owner: i.owner, status: i.status, live: i.live ? { status: i.live.status, holderStaffId: i.live.holderStaffId } : undefined })

export interface ResolvedItem extends ItemWithLive { effective: ReturnType<typeof effectiveStatus>; effectiveOwnerRole: ClearanceOwner; lostOrDamaged: boolean }
export function resolveItems(items: ItemWithLive[], personStaffId: string): ResolvedItem[] {
  return items.map(i => {
    const f = factsOf(i)
    return { ...i, effective: effectiveStatus(f, personStaffId), effectiveOwnerRole: effectiveOwner(f), lostOrDamaged: isLostOrDamaged(f) }
  })
}

export async function logEvent(tx: Tx, e: { caseId: string; itemId?: string; kind: ClearanceEventKind; actorUserId?: string | null; onBehalfOfStaffId?: string | null; note?: string | null; at?: Date }): Promise<void> {
  await tx.insert(clearanceEvent).values({
    caseId: e.caseId, itemId: e.itemId ?? null, kind: e.kind, actorUserId: e.actorUserId ?? null,
    onBehalfOfStaffId: e.onBehalfOfStaffId ?? null, note: e.note ?? null, ...(e.at ? { createdAt: e.at } : {}),
  })
}

/** Labels of the configured key and asset types ('room_key' -> 'Room key'). */
export async function itemTypeLabels(q: Reader): Promise<Map<string, string>> {
  const types = await getConfig(q, 'keys.item_types')
  return new Map(types.map(t => [t.id, t.label]))
}
export const handoverLabel = (labels: Map<string, string>, h: { itemType: string; code: string }) => `${labels.get(h.itemType) ?? h.itemType} ${h.code}`

/** Adds an item for every key or asset the person holds now that the case does not have yet (one with a later issue, for example). */
export async function ensureHandoverItems(tx: Tx, caseRow: CaseRow, actorUserId: string | null, now: Date): Promise<number> {
  const held = await outstandingHandovers(tx, caseRow.staffId)
  if (held.length === 0) return 0
  const have = new Set((await tx.select({ id: clearanceItem.handoverItemId }).from(clearanceItem).where(and(eq(clearanceItem.caseId, caseRow.id), eq(clearanceItem.kind, 'handover')))).map(r => r.id))
  const missing = held.filter(h => !have.has(h.id))
  if (missing.length === 0) return 0
  const labels = await itemTypeLabels(tx)
  const [{ n }] = await tx.select({ n: sql<number>`coalesce(max(${clearanceItem.position}), 0)::int` }).from(clearanceItem).where(eq(clearanceItem.caseId, caseRow.id))
  let pos = n
  for (const h of missing) {
    const [row] = await tx.insert(clearanceItem).values({
      caseId: caseRow.id, kind: 'handover', handoverItemId: h.id, label: handoverLabel(labels, h), mandatory: true,
      owner: h.status === 'lost' || h.status === 'damaged' ? 'AA' : 'Reception', position: ++pos,
    }).onConflictDoNothing().returning({ id: clearanceItem.id })
    if (row) await logEvent(tx, { caseId: caseRow.id, itemId: row.id, kind: 'item_added', actorUserId, note: `${h.category === 'key' ? 'Key' : 'Asset'} ${h.code} is held by the former employee`, at: now })
  }
  return missing.length
}

/**
 * Writes down what the keys register already says: a held item that has been returned (or retired) becomes Done, attributed to
 * whoever recorded the return and marked "on behalf" when that was not the former employee. Nothing is decided here; it only copies a fact.
 */
export async function syncHandoverItems(tx: Tx, caseRow: CaseRow, now: Date): Promise<number> {
  const items = resolveItems(await caseItems(tx, caseRow.id, true), caseRow.staffId)
  let n = 0
  for (const i of items) {
    if (i.kind !== 'handover' || i.effective !== 'done' || i.status === 'done' || i.status === 'waived') continue
    const [ev] = await tx.select().from(handoverEvent).where(and(eq(handoverEvent.itemId, i.handoverItemId!), inArray(handoverEvent.kind, ['returned', 'retired', 'replaced']))).orderBy(desc(handoverEvent.createdAt)).limit(1)
    await tx.update(clearanceItem).set({
      status: 'done', doneBy: ev?.actorUserId ?? null, doneAt: ev?.createdAt ?? now,
      onBehalfOfStaffId: ev ? caseRow.staffId : null, note: ev?.note ?? 'Returned or retired in Keys & assets',
    }).where(eq(clearanceItem.id, i.id))
    await logEvent(tx, { caseId: caseRow.id, itemId: i.id, kind: 'item_synced', actorUserId: ev?.actorUserId ?? null, onBehalfOfStaffId: ev ? caseRow.staffId : null, note: `${i.label} is back in the keys register (${i.live?.status ?? 'returned'})`, at: now })
    n++
  }
  return n
}

/** Keeps case.status in step with its items (never touches a cleared case). Returns the status after. */
export async function refreshCaseStatus(tx: Tx, caseRow: CaseRow): Promise<CaseRow['status']> {
  if (caseRow.status === 'cleared') return 'cleared'
  const items = resolveItems(await caseItems(tx, caseRow.id), caseRow.staffId)
  const next = deriveCaseStatus(items)
  if (next !== caseRow.status) await tx.update(clearanceCase).set({ status: next }).where(eq(clearanceCase.id, caseRow.id))
  return next
}

/** Attachment ids that really hang on this item (evidence uploaded through the attachment service). */
export async function attachmentsOnItem(q: Reader, itemId: string, ids: readonly string[] | undefined): Promise<{ ok: true } | { ok: false; missing: string[] }> {
  if (!ids || ids.length === 0) return { ok: true }
  const found = await q.select({ id: attachment.id }).from(attachment).where(and(eq(attachment.entityType, 'clearance_item'), eq(attachment.entityId, itemId), inArray(attachment.id, [...ids])))
  const have = new Set(found.map(f => f.id))
  const missing = ids.filter(i => !have.has(i))
  return missing.length ? { ok: false, missing } : { ok: true }
}
