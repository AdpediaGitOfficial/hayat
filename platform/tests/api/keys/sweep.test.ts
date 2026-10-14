/**
 * WP-I sweep `keys_overdue`, against a private database (a sweep looks at every row it can see, and the grace days are global
 * configuration). Just before and just after each boundary, run twice, run from two runners at once, and "nothing was decided":
 * the sweep tells Reception once and the Accommodation Admin once after a further grace; it never marks anything returned or lost.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createIsolated } from '../access/isolated'
import { FixedClock } from '@/server/clock'
import { listSweeps, runSweep } from '@/server/jobs/registry'
import { getDb } from '@/server/db/client'
import '@/server/jobs/sweeps'
import { listItems } from '@/server/queries/keys/items'
import { rcFor } from '../rc'

const iso = await createIsolated()
afterAll(() => iso.close())

const DAY_MS = 86_400_000
const NOW = Date.UTC(2026, 9, 14, 9, 42, 0)
const day = (n: number) => new Date(Date.UTC(2026, 9, 14) + n * DAY_MS).toISOString().slice(0, 10)
const q = <T = any>(sql: string, params: unknown[] = []) => iso.admin.query(sql, params).then(r => r.rows as T[])
const uniq = (p: string) => `${p}-${randomUUID().slice(0, 8)}`
const sweep = (clock: FixedClock) => runSweep('keys_overdue', clock)
const summary = async (clock: FixedClock) => (await sweep(clock)).summary as { reception: number; admin: number }

async function scene(o: { dueBack?: string | null; left?: boolean } = {}) {
  const siteId = await iso.newSite()
  const roomId = (await q<{ id: string }>(`INSERT INTO room (site_id, name) VALUES ($1, $2) RETURNING id`, [siteId, uniq('R')]))[0].id
  const bedId = (await q<{ id: string }>(`INSERT INTO bed (site_id, room_id, code) VALUES ($1, $2, $3) RETURNING id`, [siteId, roomId, uniq('B')]))[0].id
  const holder = await iso.makeUser({ roles: [{ role: 'Res' }] })
  const claim = (await q<{ id: string }>(`INSERT INTO bed_claim (bed_id, kind, period) VALUES ($1, 'stay', $2::daterange) RETURNING id`, [bedId, `[${day(-30)},)`]))[0].id
  const stayId = (await q<{ id: string }>(`INSERT INTO stay (staff_id, bed_id, claim_id, status, stay_type) VALUES ($1, $2, $3, 'active', 'contract') RETURNING id`, [holder.staffId, bedId, claim]))[0].id
  const itemId = (await q<{ id: string }>(
    `INSERT INTO handover_item (category, item_type, code, site_id, bed_id, status, holder_staff_id, issued_at, due_back) VALUES ('key', 'room_key', $1, $2, $3, 'issued', $4, $5, $6) RETURNING id`,
    [uniq('K'), siteId, bedId, holder.staffId, new Date(NOW - 20 * DAY_MS), o.dueBack ?? null]))[0].id
  if (o.left) await q(`UPDATE staff_profile SET employment_status = 'left', left_at = $2 WHERE id = $1`, [holder.staffId, new Date(NOW - 0)])
  return { siteId, bedId, holder, stayId, itemId }
}
const notes = (itemId: string) => q<{ dedupe_key: string; kind: string; to_role: string | null; site_id: string | null; text: string }>(
  `SELECT dedupe_key, kind, to_role, site_id, text FROM notification WHERE ref_id = $1 ORDER BY dedupe_key`, [itemId])
const itemState = async (id: string) => (await q(`SELECT status, holder_staff_id, issued_at, due_back::text, updated_at FROM handover_item WHERE id = $1`, [id]))[0]
const eventCount = async (id: string) => Number((await q(`SELECT count(*) FROM handover_event WHERE item_id = $1`, [id]))[0].count)

describe('keys_overdue: a due date (grace 1 day)', () => {
  it('nothing on the due date itself; Reception is told once the next day; the Admin only after a further grace; nothing is decided', async () => {
    const s = await scene({ dueBack: day(0) })
    const clock = new FixedClock(NOW)                                              // the due date: not overdue
    await sweep(clock)
    expect(await notes(s.itemId)).toHaveLength(0)

    const before = await itemState(s.itemId)
    clock.set(NOW + DAY_MS)                                                        // the day after: overdue, Reception told
    await sweep(clock)
    let n = await notes(s.itemId)
    expect(n.map(x => [x.kind, x.to_role, x.site_id])).toEqual([['keys.overdue', 'Rec', s.siteId]])
    expect(n[0].text).toMatch(/overdue/i)
    expect(n[0].text).toMatch(/due back on/)

    await sweep(clock)                                                             // twice: still one
    expect(await notes(s.itemId)).toHaveLength(1)

    clock.set(NOW + 2 * DAY_MS)                                                    // one more day: overdue 1 day, grace 1: not yet the Admin
    await sweep(clock)
    expect((await notes(s.itemId)).map(x => x.kind)).toEqual(['keys.overdue'])

    clock.set(NOW + 3 * DAY_MS)                                                    // overdue for 2 days (> grace): the Admin is told once
    await sweep(clock)
    await sweep(clock)
    n = await notes(s.itemId)
    expect(n.map(x => [x.kind, x.to_role])).toEqual([['keys.overdue', 'Rec'], ['keys.overdue_escalated', 'AA']])

    // nothing decided: still issued to the same person, no event, same row
    const after = await itemState(s.itemId)
    expect(after).toMatchObject({ status: 'issued', holder_staff_id: s.holder.staffId })
    expect(after.updated_at).toEqual(before.updated_at)
    expect(await eventCount(s.itemId)).toBe(0)
    expect((await q(`SELECT status FROM stay WHERE id = $1`, [s.stayId]))[0].status).toBe('active')
    const audits = await q<{ action: string }>(`SELECT action FROM audit_event WHERE entity_id = $1 ORDER BY seq`, [s.itemId])
    expect(audits.map(a => a.action)).toEqual(['keys.item.overdue_notified', 'keys.item.overdue_notified'])
  })

  it('two runners at once notify once', async () => {
    const s = await scene({ dueBack: day(-1) })
    const clock = new FixedClock(NOW)
    const results = await Promise.all([sweep(clock), sweep(clock), sweep(clock)])
    expect(results.every(r => r.ok)).toBe(true)
    expect(results.filter(r => !r.skipped).length).toBeGreaterThanOrEqual(1)
    expect((await notes(s.itemId)).filter(n => n.kind === 'keys.overdue')).toHaveLength(1)
    // the body itself is safe without the advisory lock: two instances running at the same moment still notify once
    const second = await scene({ dueBack: day(-1) })
    const body = listSweeps().find(x => x.name === 'keys_overdue')!
    const ctx = () => ({ clock, now: clock.now(), db: getDb(), requestId: 'concurrent' })
    await Promise.all([body.run(ctx()), body.run(ctx()), body.run(ctx())])
    expect((await notes(second.itemId)).filter(n => n.kind === 'keys.overdue')).toHaveLength(1)
    expect(await eventCount(s.itemId)).toBe(0)
  })

  it('returning the key stops it: a returned item is never notified, and a re-issue starts a new cycle', async () => {
    const s = await scene({ dueBack: day(-1) })
    const clock = new FixedClock(NOW)
    await sweep(clock)
    expect((await notes(s.itemId)).filter(n => n.kind === 'keys.overdue')).toHaveLength(1)
    await q(`UPDATE handover_item SET status = 'in_cabinet', holder_staff_id = NULL, issued_at = NULL, due_back = NULL WHERE id = $1`, [s.itemId])
    await sweep(clock)
    expect((await notes(s.itemId)).filter(n => n.kind === 'keys.overdue')).toHaveLength(1)
    await q(`UPDATE handover_item SET status = 'issued', holder_staff_id = $2, issued_at = $3, due_back = $4 WHERE id = $1`, [s.itemId, s.holder.staffId, new Date(NOW - DAY_MS), day(-1)])
    await sweep(clock)
    expect((await notes(s.itemId)).filter(n => n.kind === 'keys.overdue')).toHaveLength(2)                // a new issue, a new reminder
  })
})

describe('keys_overdue: after departure and Left', () => {
  it('a person who checked out: overdue after the grace days, Reception told once, the stay and key untouched', async () => {
    const s = await scene()
    await q(`UPDATE stay SET status = 'checked_out', checked_out_at = $2 WHERE id = $1`, [s.stayId, new Date(NOW - 8 * 3_600_000 - DAY_MS)])   // checked out on the 13th
    const clock = new FixedClock(NOW)
    await sweep(clock)                                                             // 1 day ago: within the grace
    expect(await notes(s.itemId)).toHaveLength(0)
    clock.set(NOW + DAY_MS)                                                        // 2 days ago: overdue
    await sweep(clock)
    const n = await notes(s.itemId)
    expect(n.map(x => x.kind)).toEqual(['keys.overdue'])
    expect(n[0].text).toMatch(/checked out/)
    expect(await itemState(s.itemId)).toMatchObject({ status: 'issued', holder_staff_id: s.holder.staffId })
    expect((await q(`SELECT status FROM stay WHERE id = $1`, [s.stayId]))[0].status).toBe('checked_out')      // not closed, not touched
  })

  it('a person who has Left: Reception is told at once', async () => {
    const s = await scene({ left: true })
    await sweep(new FixedClock(NOW))
    const n = await notes(s.itemId)
    expect(n.map(x => x.kind)).toEqual(['keys.overdue'])
    expect(n[0].text).toMatch(/has left/)
    expect(await itemState(s.itemId)).toMatchObject({ status: 'issued' })
  })

  it('lost and damaged items are not "overdue": the sweep leaves them alone', async () => {
    const s = await scene({ left: true })
    await q(`UPDATE handover_item SET status = 'lost' WHERE id = $1`, [s.itemId])
    await sweep(new FixedClock(NOW))
    expect(await notes(s.itemId)).toHaveLength(0)
  })
})

describe('the grace days are configuration', () => {
  it('a longer grace delays both the overdue flag and the reminder; the setting is read at run time', async () => {
    const s = await scene()
    await q(`UPDATE stay SET status = 'checked_out', checked_out_at = $2 WHERE id = $1`, [s.stayId, new Date(NOW - 3 * DAY_MS)])
    const reader = await iso.makeUser({ roles: [{ role: 'Rec', siteId: s.siteId }] })
    const actor = rcFor(reader.id, { role: 'Rec', sites: [s.siteId], staffId: reader.staffId }).actor
    const clock = new FixedClock(NOW)
    expect((await listItems(actor, { siteId: s.siteId, overdue: true }, clock.now())).rows.map(r => r.id)).toContain(s.itemId)      // 3 days > 1
    await q(`INSERT INTO config_item (key, scope_site_id, version, value) VALUES ('keys.overdue_grace_days', NULL, 1, '5'::jsonb)`)
    try {
      expect((await listItems(actor, { siteId: s.siteId, overdue: true }, clock.now())).rows.map(r => r.id)).not.toContain(s.itemId)
      await sweep(clock)
      expect(await notes(s.itemId)).toHaveLength(0)
    } finally {
      await q(`INSERT INTO config_item (key, scope_site_id, version, value) VALUES ('keys.overdue_grace_days', NULL, 2, '1'::jsonb)`)
    }
    await sweep(clock)
    expect((await notes(s.itemId)).map(n => n.kind)).toEqual(['keys.overdue'])
  })
})
