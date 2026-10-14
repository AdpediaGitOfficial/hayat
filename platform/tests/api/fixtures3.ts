/** Arrangement helpers for the Stage 3 tests (keys and assets, cleaning, attachments, clearance setup). Builds on fixtures2. */
import { randomBytes } from 'node:crypto'
import { admin, uniq } from './harness'
export * from './fixtures2'

export async function mkItem(o: { siteId: string; bedId?: string; roomId?: string; category?: 'key' | 'asset'; itemType?: string; status?: string; holderStaffId?: string; code?: string }) {
  const status = o.status ?? (o.holderStaffId ? 'issued' : 'in_cabinet')
  const r = await admin().query<{ id: string }>(
    `INSERT INTO handover_item (category, item_type, code, site_id, room_id, bed_id, status, holder_staff_id, issued_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CASE WHEN $8::uuid IS NOT NULL THEN now() END) RETURNING id`,
    [o.category ?? 'key', o.itemType ?? 'room_key', o.code ?? uniq('K'), o.siteId, o.roomId ?? null, o.bedId ?? null, status, o.holderStaffId ?? null])
  return r.rows[0].id
}

/** An active stay in the bed (claim, stay, bed occupied), for a given person. */
export async function mkStayFor(o: { staffId: string; bedId: string; from?: string }) {
  const claim = (await admin().query<{ id: string }>(`INSERT INTO bed_claim (bed_id, kind, period) VALUES ($1, 'stay', $2::daterange) RETURNING id`, [o.bedId, `[${o.from ?? '2026-10-01'},)`])).rows[0].id
  const stay = (await admin().query<{ id: string }>(`INSERT INTO stay (staff_id, bed_id, claim_id, status, stay_type) VALUES ($1, $2, $3, 'active', 'permanent') RETURNING id`, [o.staffId, o.bedId, claim])).rows[0].id
  await admin().query(`UPDATE bed SET state = 'occupied' WHERE id = $1`, [o.bedId])
  return { stayId: stay, claimId: claim }
}

export async function cleaningTasks(bedId: string) {
  return (await admin().query<{ id: string; status: string; reason: string }>(`SELECT id, status, reason FROM cleaning_task WHERE bed_id = $1 ORDER BY created_at`, [bedId])).rows
}

/** Smallest valid files of each accepted type (content is what the sniffer checks). */
export const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(24)])
export const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(24)])
export const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), randomBytes(24)])
