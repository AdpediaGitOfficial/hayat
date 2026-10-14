/**
 * Helpers shared by the WP-F commands: row loaders that take the right lock, "who may decide this" checks,
 * the site-local "today", and a readable bed path for messages.
 *
 * Locking order, everywhere: request row -> stays (by id) -> beds (by id). Check-in locks reservation -> bed.
 * One order means two transfers, a swap and a checkout can wait for each other but never deadlock; the rare
 * deadlock Postgres still detects is retried once by runCommand.
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import { bed, bedClaim, building, reservation, room, site, staffProfile, stay } from '@/server/db/schema'
import type { Tx } from '@/server/command/context'
import type { CommandContext } from '@/server/command/context'
import { fail, failure, type Failure } from '@/server/command/result'
import { decide, type Action, type Resource } from '@/server/policy'
import { todayInZone } from '@/server/commands/property/shared'
import { loadCalendar } from '@/server/eligibility'
import { getConfig } from '@/server/config/registry'
import { approvalClock } from '@/domain/approvals'

export { idSchema, isUuid, reasonSchema, todayInZone } from '@/server/commands/property/shared'
export const dateSchema = z.iso.date('Use a date like 2026-11-30')
export const noteSchema = z.string().trim().max(500, 'At most 500 characters').nullish().transform(v => (v ? v : null))

/* ---------------- stays ---------------- */

export interface StayFull {
  id: string
  staffId: string
  bedId: string
  claimId: string
  reservationId: string | null
  status: typeof stay.$inferSelect['status']
  stayType: typeof stay.$inferSelect['stayType']
  checkedInAt: Date
  siteId: string
  bedCode: string
  bedState: string
  /** First night of the live claim and the departure day (null = open-ended). */
  from: string
  to: string | null
}

const stayCols = () => ({
  id: stay.id, staffId: stay.staffId, bedId: stay.bedId, claimId: stay.claimId, reservationId: stay.reservationId, status: stay.status,
  stayType: stay.stayType, checkedInAt: stay.checkedInAt, siteId: bed.siteId, bedCode: bed.code, bedState: bed.state,
  from: sql<string>`lower(${bedClaim.period})::text`, to: sql<string | null>`upper(${bedClaim.period})::text`,
})

/** Loads stays FOR UPDATE (rows of `stay` only), ordered by id so two callers always lock in the same order. */
export async function loadStaysLocked(tx: Tx, ids: string[]): Promise<StayFull[]> {
  if (ids.length === 0) return []
  return tx.select(stayCols()).from(stay)
    .innerJoin(bed, eq(bed.id, stay.bedId)).innerJoin(bedClaim, eq(bedClaim.id, stay.claimId))
    .where(inArray(stay.id, ids)).orderBy(asc(stay.id)).for('update', { of: stay })
}
export async function loadStayLocked(tx: Tx, id: string): Promise<StayFull | undefined> {
  return (await loadStaysLocked(tx, [id]))[0]
}
export async function loadStay(tx: Pick<Tx, 'select'>, id: string): Promise<StayFull | undefined> {
  const [r] = await tx.select(stayCols()).from(stay)
    .innerJoin(bed, eq(bed.id, stay.bedId)).innerJoin(bedClaim, eq(bedClaim.id, stay.claimId)).where(eq(stay.id, id)).limit(1)
  return r
}

/** Locks bed rows in id order and returns them. */
export async function lockBeds(tx: Tx, ids: string[]) {
  const unique = [...new Set(ids)]
  if (unique.length === 0) return []
  return tx.select().from(bed).where(inArray(bed.id, unique)).orderBy(asc(bed.id)).for('update')
}

export async function siteToday(q: Pick<Tx, 'select'>, siteId: string, now: Date): Promise<string> {
  const [s] = await q.select({ tz: site.timeZone }).from(site).where(eq(site.id, siteId)).limit(1)
  return todayInZone(now, s?.tz ?? 'UTC')
}

export const OCCUPYING = ['provisional', 'active', 'resolution_pending'] as const

/** "Palm Villas › Block A › Room 12 › Bed A" for messages and audit. */
export async function bedLabel(q: Pick<Tx, 'select'>, bedId: string): Promise<string> {
  const [r] = await q.select({ site: site.name, building: building.name, room: room.name, code: bed.code }).from(bed)
    .innerJoin(room, eq(room.id, bed.roomId)).innerJoin(site, eq(site.id, bed.siteId)).leftJoin(building, eq(building.id, room.buildingId))
    .where(eq(bed.id, bedId)).limit(1)
  return r ? [r.site, r.building, r.room, `Bed ${r.code}`].filter(Boolean).join(' › ') : 'a bed'
}

export async function staffName(q: Pick<Tx, 'select'>, staffId: string): Promise<string> {
  const [r] = await q.select({ n: staffProfile.fullName }).from(staffProfile).where(eq(staffProfile.id, staffId)).limit(1)
  return r?.n ?? 'The resident'
}

export async function reservationRow(tx: Tx, id: string, lock: boolean) {
  const q = tx.select({
    id: reservation.id, staffId: reservation.staffId, bedId: reservation.bedId, claimId: reservation.claimId, status: reservation.status,
    eta: reservation.eta, requestId: reservation.requestId, stayType: reservation.stayType, noShowExtended: reservation.noShowExtended, source: reservation.source,
    siteId: bed.siteId, bedCode: bed.code, from: sql<string>`lower(${bedClaim.period})::text`, to: sql<string | null>`upper(${bedClaim.period})::text`,
  }).from(reservation).innerJoin(bed, eq(bed.id, reservation.bedId)).innerJoin(bedClaim, eq(bedClaim.id, reservation.claimId))
    .where(and(eq(reservation.id, id)))
  return (lock ? (await q.for('update', { of: reservation }))[0] : (await q)[0])
}

/* ---------------- who may do this ---------------- */

/**
 * The actor may do the thing if ANY of the actions is granted for this resource. A record the actor has a grant for but
 * cannot reach reads as "not found" (AT-001/002); no grant at all is "forbidden".
 */
export function authorizeAny(c: Pick<CommandContext, 'actor'>, actions: readonly Action[], res: Resource): Failure | undefined {
  let outOfScope = false
  for (const a of actions) {
    const d = decide(c.actor, a, res)
    if (d.allowed) return undefined
    if (d.reason === 'out_of_scope') outOfScope = true
  }
  return outOfScope ? fail.notFound() : fail.forbidden(`do this (${actions.join(' or ')})`)
}

/** D-26: none of the people the record is about, or who raised it, may decide or execute it. */
export function notInvolved(c: Pick<CommandContext, 'actor'>, staffIds: (string | null | undefined)[], what: string): Failure | undefined {
  const me = c.actor.staffId
  if (me && staffIds.includes(me)) return fail.sod(`You cannot ${what}: it is about you or was raised by you`, 'An independent approver must do this (D-26)')
  return undefined
}

export type DecisionKind = 'transfer' | 'extension' | 'extension_beyond'
const PRIMARY: Record<DecisionKind, Action> = {
  transfer: 'transfers_swaps.approve',
  extension: 'reservations_stays.approve_extension',
  extension_beyond: 'reservations_stays.approve_extension_beyond_policy',
}
/** Backup approvers and Policy Approvers (capabilities) decide once the item has been routed past the primary (APPROVALS.md). */
const BACKUP: Action = 'approvals_inbox.decide_escalated'

/**
 * May this actor decide this item right now? The primary decider (Accommodation Admin; for an extension beyond policy the
 * Policy Approver) at any time; a backup approver or Policy Approver only once the SLA clock has routed the item to the
 * backup level (reminder at 1 business day, backup at 2, escalated at 3). Scope always comes from the actor's own sites.
 */
export async function authorizeDecision(c: CommandContext, o: { kind: DecisionKind; siteId: string; since: Date }): Promise<Failure | undefined> {
  const res = { siteId: o.siteId }
  const primary = decide(c.actor, PRIMARY[o.kind], res)
  if (primary.allowed) return undefined
  const backup = decide(c.actor, BACKUP, res)
  if (!backup.allowed) {
    return primary.reason === 'out_of_scope' || backup.reason === 'out_of_scope' ? fail.notFound() : fail.forbidden(`decide this (${PRIMARY[o.kind]})`)
  }
  const clock = approvalClock(o.since.getTime(), c.now.getTime(), await getConfig(c.tx, 'timers.routine_sla_business_days'), await loadCalendar(c.tx, o.siteId))
  if (clock.level >= 1) return undefined
  const first = o.kind === 'extension_beyond' ? 'a Policy Approver' : 'the Accommodation Admin'
  return failure('forbidden', `This is waiting for ${first}. It reaches the backup approver after ${await getConfig(c.tx, 'timers.routine_sla_business_days')} business days`, {
    owner: first === 'a Policy Approver' ? 'Policy Approver' : 'Accommodation Admin', next: 'Ask them to decide, or wait for the reminder and escalation',
  })
}

/* ---------------- snapshots for audit ---------------- */

export const staySnap = (s: Pick<StayFull, 'status' | 'bedId' | 'claimId' | 'from' | 'to'>) => ({ status: s.status, bedId: s.bedId, claimId: s.claimId, from: s.from, to: s.to })
export const bedSnap = (b: { state: string; stateReason?: string | null }) => ({ state: b.state, reason: b.stateReason ?? null })

/** Placeholder recorded with every move until keys exist (Stage 3): where the key return and reissue will be written. */
export const KEYS_PLACEHOLDER = { keysReturned: 'to be recorded (keys are Stage 3)', keysIssued: 'to be recorded (keys are Stage 3)' } as const
