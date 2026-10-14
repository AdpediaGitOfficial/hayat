/**
 * Arrangement helpers for the WP-F tests. Data is created with the superuser pool, actions go through the real commands
 * as app_role (tests/api/rc.ts), exactly like the Stage 2 core tests. Every call builds its own graph, so files run in parallel.
 */
import { admin, makeUser, type TestUser } from '../harness'
import { FixedClock } from '@/server/clock'
import { rcFor } from '../rc'
import type { Capability, Role } from '@/domain/enums'
import type { RequestContext } from '@/server/command/context'
import { mkBed, mkProperty, mkRoom } from '../fixtures2'

export { day, mkBed, mkProperty, mkRoom, mkSite, mkStaff, setConfigValue, liveClaims, notificationsByKey } from '../fixtures2'
export { rcFor }

/** 2026-10-14 09:42 UTC: the default FixedClock, so day(0) is "today". */
export const NOW = Date.UTC(2026, 9, 14, 9, 42, 0)
export const newClock = () => new FixedClock(NOW)
export const DAY_MS = 86_400_000

export interface Person { user: TestUser; rc: RequestContext; staffId: string; userId: string }

/** A signed-in person (as a command context) with a role at the given sites, optionally with capabilities. */
export async function person(role: Role, o: { siteIds?: string[]; caps?: Capability[]; clock?: FixedClock } = {}): Promise<Person> {
  const user = await makeUser({ roles: [role === 'SA' ? { role, all: true } : role === 'Res' ? { role } : { role }] })
  const sites: readonly string[] | 'all' = role === 'SA' ? 'all' : role === 'Res' ? [] : o.siteIds ?? []
  const rc = rcFor(user.id, { role, sites, caps: o.caps ?? [], staffId: user.staffId }, o.clock ?? newClock())
  return { user, rc, staffId: user.staffId, userId: user.id }
}

/** Same person as another role or at another clock time (the stay/request data is unchanged). */
export const as = (p: Person, role: Role, o: { siteIds?: string[]; caps?: Capability[]; clock?: FixedClock } = {}): Person =>
  ({ ...p, rc: rcFor(p.userId, { role, sites: role === 'SA' ? 'all' : role === 'Res' ? [] : o.siteIds ?? [], caps: o.caps ?? [], staffId: p.staffId }, o.clock ?? p.rc.clock as FixedClock) })

export interface Reserved { reservationId: string; claimId: string; staffId: string }

/** A live reservation `reserved` for a person on a bed for [from, to). eta defaults to noon on the arrival day. */
export async function mkReservation(o: { bedId: string; staffId: string; from: string; to?: string | null; eta?: string; extended?: boolean }): Promise<Reserved> {
  const period = o.to === null || o.to === undefined ? `[${o.from},)` : `[${o.from},${o.to})`
  const claim = (await admin().query<{ id: string }>(`INSERT INTO bed_claim (bed_id, kind, period) VALUES ($1, 'reservation', $2::daterange) RETURNING id`, [o.bedId, period])).rows[0]
  const r = (await admin().query<{ id: string }>(
    `INSERT INTO reservation (staff_id, bed_id, claim_id, eta, source, stay_type, no_show_extended) VALUES ($1, $2, $3, $4, 'request', 'contract', $5) RETURNING id`,
    [o.staffId, o.bedId, claim.id, o.eta ?? `${o.from}T12:00:00Z`, o.extended ?? false])).rows[0]
  return { reservationId: r.id, claimId: claim.id, staffId: o.staffId }
}

/** An active stay: a 'stay' claim for [from, to) (open-ended when to is null), the stay row, the bed Occupied. */
export async function mkStay(o: { bedId: string; staffId: string; from: string; to?: string | null; status?: string }): Promise<{ stayId: string; claimId: string }> {
  const period = o.to === null || o.to === undefined ? `[${o.from},)` : `[${o.from},${o.to})`
  const claim = (await admin().query<{ id: string }>(`INSERT INTO bed_claim (bed_id, kind, period) VALUES ($1, 'stay', $2::daterange) RETURNING id`, [o.bedId, period])).rows[0]
  const s = (await admin().query<{ id: string }>(
    `INSERT INTO stay (staff_id, bed_id, claim_id, status, stay_type, checked_in_at) VALUES ($1, $2, $3, $4, 'contract', $5) RETURNING id`,
    [o.staffId, o.bedId, claim.id, o.status ?? 'active', `${o.from}T10:00:00Z`])).rows[0]
  await admin().query(`UPDATE bed SET state = 'occupied' WHERE id = $1 AND state = 'available'`, [o.bedId])
  return { stayId: s.id, claimId: claim.id }
}

export async function bedState(bedId: string): Promise<string> {
  return (await admin().query<{ state: string }>(`SELECT state FROM bed WHERE id = $1`, [bedId])).rows[0].state
}
/** Moves a bed to a state along LEGAL transitions only (the database guards them), by breadth-first search over state_transition. */
export async function setBedState(bedId: string, target: string) {
  const edges = (await admin().query<{ from_state: string; to_state: string }>(`SELECT from_state, to_state FROM state_transition WHERE entity = 'bed.state'`)).rows
  const start = await bedState(bedId)
  if (start === target) return
  const prev = new Map<string, string>([[start, '']])
  const queue = [start]
  while (queue.length && !prev.has(target)) {
    const cur = queue.shift()!
    for (const e of edges.filter(x => x.from_state === cur)) if (!prev.has(e.to_state)) { prev.set(e.to_state, cur); queue.push(e.to_state) }
  }
  if (!prev.has(target)) throw new Error(`no legal path ${start} -> ${target}`)
  const path: string[] = []
  for (let s = target; s !== start; s = prev.get(s)!) path.unshift(s)
  for (const step of path) await admin().query(`UPDATE bed SET state = $2 WHERE id = $1`, [bedId, step])
}
export async function stayRow(stayId: string) {
  return (await admin().query<{ id: string; bed_id: string; claim_id: string; status: string; checked_out_at: Date | null; reservation_id: string | null }>(
    `SELECT id, bed_id, claim_id, status, checked_out_at, reservation_id FROM stay WHERE id = $1`, [stayId])).rows[0]
}
export async function claimRow(claimId: string) {
  return (await admin().query<{ id: string; bed_id: string; kind: string; period: string; released_at: Date | null; release_reason: string | null }>(
    `SELECT id, bed_id, kind, period::text, released_at, release_reason FROM bed_claim WHERE id = $1`, [claimId])).rows[0]
}
export async function reservationRowOf(id: string) {
  return (await admin().query<{ status: string; cancel_reason: string | null }>(`SELECT status, cancel_reason FROM reservation WHERE id = $1`, [id])).rows[0]
}
export async function auditRows(entityId: string) {
  return (await admin().query<{ action: string; actor_role: string | null; reason: string | null; before: any; after: any }>(
    `SELECT action, actor_role, reason, before, after FROM audit_event WHERE entity_id = $1 ORDER BY seq`, [entityId])).rows
}
export async function transferRow(id: string) {
  return (await admin().query(`SELECT * FROM transfer_request WHERE id = $1`, [id])).rows[0] as Record<string, any>
}
export async function notificationsFor(refId: string) {
  return (await admin().query<{ dedupe_key: string; kind: string; to_role: string | null; to_staff_id: string | null; text: string; critical: boolean }>(
    `SELECT dedupe_key, kind, to_role, to_staff_id, text, critical FROM notification WHERE ref_id = $1 ORDER BY created_at, dedupe_key`, [refId])).rows
}

/** A site with a room of `beds` beds plus the standard cast: an Accommodation Admin and Reception of the site. */
export async function world(o: { beds?: number } = {}) {
  const p = await mkProperty({ beds: o.beds ?? 4 })
  const aa = await person('AA', { siteIds: [p.siteId] })
  const rec = await person('Rec', { siteIds: [p.siteId] })
  return { ...p, aa, rec }
}

/** Several residents with accounts. */
export async function residents(n: number): Promise<Person[]> {
  const out: Person[] = []
  for (let i = 0; i < n; i++) out.push(await person('Res'))
  return out
}

export { mkBed as bedIn, mkRoom as roomIn }
