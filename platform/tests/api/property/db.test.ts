/** Migration 0010 at the database level: what holds even if application code has a bug. */
import { afterAll, describe, expect, it } from 'vitest'
import { admin, closeAll } from '../harness'
import { mkProperty } from './helpers'

afterAll(closeAll)

const fails = async (sql: string, args: unknown[]) => {
  try { await admin().query(sql, args) } catch (e) { return (e as { code: string; constraint?: string }) }
  throw new Error('expected the statement to fail')
}

describe('bed_block (0010)', () => {
  it('at most one block is open per bed; a released block is history and does not count', async () => {
    const p = await mkProperty({ beds: 1 })
    const ins = `INSERT INTO bed_block (bed_id, site_id, reason) VALUES ($1, $2, 'Leak') RETURNING id`
    const first = (await admin().query<{ id: string }>(ins, [p.bedIds[0], p.siteId])).rows[0].id
    expect((await fails(ins, [p.bedIds[0], p.siteId])).constraint).toBe('one_open_block_per_bed')
    await admin().query(`UPDATE bed_block SET released_at = now() WHERE id = $1`, [first])
    await admin().query(ins, [p.bedIds[0], p.siteId])
  })

  it('a block needs a real reason, and its site must be the bed\'s site', async () => {
    const p = await mkProperty({ beds: 1 })
    const other = await mkProperty({ beds: 0 })
    expect((await fails(`INSERT INTO bed_block (bed_id, site_id, reason) VALUES ($1, $2, '   ')`, [p.bedIds[0], p.siteId])).code).toBe('23514')
    expect((await fails(`INSERT INTO bed_block (bed_id, site_id, reason) VALUES ($1, $2, 'Leak')`, [p.bedIds[0], other.siteId])).code).toBe('23503')
  })

  it('"released by" without "released at" is refused', async () => {
    const p = await mkProperty({ beds: 1 })
    const u = (await admin().query<{ id: string }>(`INSERT INTO user_account (username, status) VALUES ($1, 'active') RETURNING id`, ['u-' + p.bedIds[0]])).rows[0].id
    expect((await fails(`INSERT INTO bed_block (bed_id, site_id, reason, released_by) VALUES ($1, $2, 'Leak', $3)`, [p.bedIds[0], p.siteId, u])).code).toBe('23514')
  })
})

describe('archive guards (0010)', () => {
  it('a released claim does not stop an archive, and an archived bed accepts no new live claim but keeps its history', async () => {
    const p = await mkProperty({ beds: 1 })
    const c = (await admin().query<{ id: string }>(`INSERT INTO bed_claim (bed_id, kind, period) VALUES ($1, 'reservation', '[2026-11-01,2026-11-05)') RETURNING id`, [p.bedIds[0]])).rows[0].id
    await admin().query(`UPDATE bed_claim SET released_at = now(), release_reason = 'cancelled' WHERE id = $1`, [c])
    await admin().query(`UPDATE bed SET state = 'archived', archived_at = now() WHERE id = $1`, [p.bedIds[0]])
    expect((await fails(`INSERT INTO bed_claim (bed_id, kind, period) VALUES ($1, 'stay', '[2026-11-01,)')`, [p.bedIds[0]])).code).toBe('GH001')
    // History rows (already released) may still be written for an archived bed, e.g. by a late import of old data.
    await admin().query(`INSERT INTO bed_claim (bed_id, kind, period, released_at, release_reason) VALUES ($1, 'stay', '[2025-01-01,2025-02-01)', now(), 'history')`, [p.bedIds[0]])
  })
})
