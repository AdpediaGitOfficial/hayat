/**
 * Arrangement kit for WP-F tests that need a PRIVATE database (sweeps look at every row in the database, and the atomicity
 * test installs a trigger), so they cannot share the database the other test files use at the same time.
 * Do NOT import ../harness or ./helpers in a file that imports this (they point the pool at the shared database).
 */
import { randomUUID } from 'node:crypto'
import { FixedClock } from '@/server/clock'
import { rcFor } from '../rc'
import type { Isolated } from '../access/isolated'
import type { Capability, Role } from '@/domain/enums'
import type { RequestContext } from '@/server/command/context'

export const NOW = Date.UTC(2026, 9, 14, 9, 42, 0)
export const DAY_MS = 86_400_000
export const HOUR_MS = 3_600_000
export const day = (n: number) => new Date(Date.UTC(2026, 9, 14) + n * DAY_MS).toISOString().slice(0, 10)

export interface Who { userId: string; staffId: string; rc: RequestContext }

export function kit(iso: Isolated, clock: FixedClock) {
  const q = <T = any>(sql: string, params: unknown[] = []) => iso.admin.query(sql, params).then(r => r.rows as T[])
  const uniq = (p: string) => `${p}-${randomUUID().slice(0, 8)}`

  async function person(role: Role, o: { siteIds?: string[]; caps?: Capability[] } = {}): Promise<Who> {
    const u = await iso.makeUser({ roles: [role === 'SA' ? { role, all: true } : role === 'Res' ? { role } : { role }] })
    const sites: readonly string[] | 'all' = role === 'SA' ? 'all' : role === 'Res' ? [] : o.siteIds ?? []
    return { userId: u.id, staffId: u.staffId, rc: rcFor(u.id, { role, sites, caps: o.caps ?? [], staffId: u.staffId }, clock) }
  }

  async function world(beds = 4) {
    const siteId = await iso.newSite()
    const roomId = (await q<{ id: string }>(`INSERT INTO room (site_id, name) VALUES ($1, $2) RETURNING id`, [siteId, uniq('R')]))[0].id
    const bedIds: string[] = []
    for (let i = 0; i < beds; i++) bedIds.push((await q<{ id: string }>(`INSERT INTO bed (site_id, room_id, code) VALUES ($1, $2, $3) RETURNING id`, [siteId, roomId, uniq('B')]))[0].id)
    return { siteId, roomId, bedIds, aa: await person('AA', { siteIds: [siteId] }), rec: await person('Rec', { siteIds: [siteId] }), res: () => person('Res') }
  }

  async function reservation(o: { bedId: string; staffId: string; from: string; to?: string | null; eta?: string; extended?: boolean }) {
    const period = o.to ? `[${o.from},${o.to})` : `[${o.from},)`
    const claim = (await q<{ id: string }>(`INSERT INTO bed_claim (bed_id, kind, period) VALUES ($1, 'reservation', $2::daterange) RETURNING id`, [o.bedId, period]))[0]
    const r = (await q<{ id: string }>(
      `INSERT INTO reservation (staff_id, bed_id, claim_id, eta, source, stay_type, no_show_extended) VALUES ($1, $2, $3, $4, 'request', 'contract', $5) RETURNING id`,
      [o.staffId, o.bedId, claim.id, o.eta ?? `${o.from}T12:00:00Z`, o.extended ?? false]))[0]
    return { reservationId: r.id, claimId: claim.id }
  }

  async function stay(o: { bedId: string; staffId: string; from: string; to?: string | null }) {
    const period = o.to ? `[${o.from},${o.to})` : `[${o.from},)`
    const claim = (await q<{ id: string }>(`INSERT INTO bed_claim (bed_id, kind, period) VALUES ($1, 'stay', $2::daterange) RETURNING id`, [o.bedId, period]))[0]
    const s = (await q<{ id: string }>(`INSERT INTO stay (staff_id, bed_id, claim_id, status, stay_type, checked_in_at) VALUES ($1, $2, $3, 'active', 'contract', $4) RETURNING id`, [o.staffId, o.bedId, claim.id, `${o.from}T10:00:00Z`]))[0]
    await q(`UPDATE bed SET state = 'occupied' WHERE id = $1 AND state = 'available'`, [o.bedId])
    return { stayId: s.id, claimId: claim.id }
  }

  return {
    q, uniq, person, world, reservation, stay,
    bedState: async (id: string) => (await q<{ state: string }>(`SELECT state FROM bed WHERE id = $1`, [id]))[0].state,
    stayRow: async (id: string) => (await q(`SELECT id, bed_id, claim_id, status, checked_out_at FROM stay WHERE id = $1`, [id]))[0] as { id: string; bed_id: string; claim_id: string; status: string; checked_out_at: Date | null },
    claimRow: async (id: string) => (await q(`SELECT id, bed_id, kind, period::text, released_at, release_reason FROM bed_claim WHERE id = $1`, [id]))[0] as { id: string; bed_id: string; kind: string; period: string; released_at: Date | null; release_reason: string | null },
    reservationRow: async (id: string) => (await q(`SELECT status, cancel_reason FROM reservation WHERE id = $1`, [id]))[0] as { status: string; cancel_reason: string | null },
    notifications: (refId: string) => q<{ dedupe_key: string; kind: string; to_role: string | null; to_staff_id: string | null; text: string; critical: boolean }>(`SELECT dedupe_key, kind, to_role, to_staff_id, text, critical FROM notification WHERE ref_id = $1 ORDER BY dedupe_key`, [refId]),
    audits: (entityId: string) => q<{ action: string; actor_role: string | null; actor_user_id: string | null; reason: string | null; before: any; after: any }>(`SELECT action, actor_role, actor_user_id, reason, before, after FROM audit_event WHERE entity_id = $1 ORDER BY seq`, [entityId]),
    liveClaims: (bedId: string) => q<{ id: string; kind: string; period: string }>(`SELECT id, kind, period::text FROM bed_claim WHERE bed_id = $1 AND released_at IS NULL ORDER BY lower(period)`, [bedId]),
  }
}
