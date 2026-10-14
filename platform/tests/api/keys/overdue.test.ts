/**
 * Overdue is computed, never stored (D-73). The boundaries, to the day: held past a due date (overdue from the next day), held by a
 * person whose stay ended more than the grace days ago, held by a person who has Left (at once). Pure rules first, then the same
 * rules through the listing a screen uses.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { admin, closeAll } from '../harness'
import { checkOutDirectly, day, mkItem, newClock, resident, world } from './helpers'
import { overdueState, localDate, type HolderFacts } from '@/server/queries/keys/overdue'
import { listItems } from '@/server/queries/keys/items'

afterAll(closeAll)

const at = (isoDate: string, hh = 9) => new Date(`${isoDate}T${String(hh).padStart(2, '0')}:00:00Z`)
const NOW = at(day(0))                                                                  // 2026-10-14
const facts = (o: Partial<HolderFacts> = {}): HolderFacts => ({ left: false, leftAt: null, occupying: false, lastEnded: null, ...o })
const state = (o: { dueBack?: string | null; holder?: HolderFacts; grace?: number; now?: Date; tz?: string; status?: string }) =>
  overdueState({ status: o.status ?? 'issued', dueBack: o.dueBack ?? null, timeZone: o.tz ?? 'UTC', now: o.now ?? NOW, graceDays: o.grace ?? 1, holder: o.holder ?? facts({ occupying: true }) })

describe('the rules (pure)', () => {
  it('a due date: not overdue on the day, overdue from the day after', () => {
    expect(state({ dueBack: day(0) }).overdue).toBe(false)
    expect(state({ dueBack: day(1) }).overdue).toBe(false)
    const o = state({ dueBack: day(-1) })
    expect(o).toMatchObject({ overdue: true, reason: 'due_date', since: day(0), daysOver: 0 })
    expect(state({ dueBack: day(-5) })).toMatchObject({ overdue: true, since: day(-4), daysOver: 4 })
  })

  it('after departure: overdue when the stay ended MORE than the grace days ago (grace 1: out on the 12th, overdue from the 14th)', () => {
    const ended = (n: number) => facts({ lastEnded: at(day(n), 8) })
    expect(state({ holder: ended(0) }).overdue).toBe(false)                                // left today
    expect(state({ holder: ended(-1) }).overdue).toBe(false)                               // 1 day ago = within the grace
    expect(state({ holder: ended(-2) })).toMatchObject({ overdue: true, reason: 'departed', since: day(0) })
    expect(state({ holder: ended(-1), grace: 0 }).overdue).toBe(true)                      // grace 0: from the day after
    expect(state({ holder: ended(0), grace: 0 }).overdue).toBe(false)
    expect(state({ holder: ended(-5), grace: 7 }).overdue).toBe(false)
    expect(state({ holder: ended(-8), grace: 7 }).overdue).toBe(true)
  })

  it('a person who is still in a bed is not overdue because an EARLIER stay ended', () => {
    expect(state({ holder: facts({ occupying: true, lastEnded: at(day(-30)) }) }).overdue).toBe(false)
  })

  it('a person who has Left: overdue at once, no grace', () => {
    expect(state({ holder: facts({ left: true, leftAt: NOW, occupying: true }) })).toMatchObject({ overdue: true, reason: 'left', since: day(0) })
    expect(state({ holder: facts({ left: true, leftAt: at(day(-3)) }) })).toMatchObject({ overdue: true, since: day(-3), daysOver: 3 })
  })

  it('the earliest reason wins; only an issued item can be overdue', () => {
    expect(state({ dueBack: day(-2), holder: facts({ left: true, leftAt: at(day(-6)) }) })).toMatchObject({ reason: 'left', since: day(-6) })
    for (const status of ['in_cabinet', 'lost', 'damaged', 'retired']) expect(state({ status, dueBack: day(-9), holder: facts({ left: true, leftAt: NOW }) }).overdue).toBe(false)
  })

  it('"today" is the site\'s calendar day, not UTC', () => {
    const lateUtc = new Date('2026-10-14T20:00:00Z')                                       // already 15 Oct in Auckland (+13), still 14 Oct in UTC
    expect(localDate(lateUtc, 'UTC')).toBe('2026-10-14')
    expect(localDate(lateUtc, 'Pacific/Auckland')).toBe('2026-10-15')
    expect(state({ dueBack: '2026-10-14', now: lateUtc, tz: 'UTC' }).overdue).toBe(false)
    expect(state({ dueBack: '2026-10-14', now: lateUtc, tz: 'Pacific/Auckland' }).overdue).toBe(true)
  })
})

describe('through the listing a screen uses', () => {
  it('flags overdue by due date, by departure plus grace and by Left, and filters on it; the cabinet and lost items are never overdue', async () => {
    const w = await world({ beds: 4 })
    const [a, b, c, d] = await Promise.all([0, 1, 2, 3].map(i => resident(w.bedIds[i])))
    const clock = newClock()
    const dueItem = await mkItem({ siteId: w.siteId, bedId: w.bedIds[0], holderStaffId: a.staffId })
    await admin().query(`UPDATE handover_item SET due_back = $2 WHERE id = $1`, [dueItem, day(-1)])
    const leftItem = await mkItem({ siteId: w.siteId, bedId: w.bedIds[2], holderStaffId: c.staffId })
    await admin().query(`UPDATE staff_profile SET employment_status = 'left', left_at = $2 WHERE id = $1`, [c.staffId, at(day(-1))])
    const departedItem = await mkItem({ siteId: w.siteId, bedId: w.bedIds[1], holderStaffId: b.staffId })
    await checkOutDirectly(b.stayId, `${day(-2)}T08:00:00Z`)
    const freshItem = await mkItem({ siteId: w.siteId, bedId: w.bedIds[3], holderStaffId: d.staffId })
    const lostItem = await mkItem({ siteId: w.siteId, status: 'lost', holderStaffId: c.staffId })
    const cabinet = await mkItem({ siteId: w.siteId })

    const all = await listItems(w.rec.rc.actor, { siteId: w.siteId }, clock.now())
    const by = new Map(all.rows.map(r => [r.id, r]))
    expect(by.get(dueItem)!.overdue).toMatchObject({ overdue: true, reason: 'due_date' })
    expect(by.get(leftItem)!.overdue).toMatchObject({ overdue: true, reason: 'left' })
    expect(by.get(departedItem)!.overdue).toMatchObject({ overdue: true, reason: 'departed' })
    expect(by.get(freshItem)!.overdue.overdue).toBe(false)
    expect(by.get(lostItem)!.overdue.overdue).toBe(false)
    expect(by.get(cabinet)!.overdue.overdue).toBe(false)
    const only = await listItems(w.rec.rc.actor, { siteId: w.siteId, overdue: true }, clock.now())
    expect(only.rows.map(r => r.id).sort()).toEqual([dueItem, leftItem, departedItem].sort())
    expect(all.rows[0].overdue.overdue).toBe(true)                                            // most urgent first
    // one day earlier nothing departed is overdue yet; the stored status never changed
    const earlier = await listItems(w.rec.rc.actor, { siteId: w.siteId, overdue: true }, at(day(-1)))
    expect(earlier.rows.map(r => r.id)).not.toContain(departedItem)
    expect((await admin().query(`SELECT status FROM handover_item WHERE id = $1`, [departedItem])).rows[0].status).toBe('issued')
  })
})
