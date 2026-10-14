import { describe, expect, it } from 'vitest'
import {
  approvalClock, bedAllocatable, bedConflict, bedPath, eligibility, overlaps, resStatusView, selfAction, stayState, suggestBeds,
} from '@/domain/rules'
import { claimPeriod } from '@/domain/claims'
import { DAY, HOUR } from '@/domain/time'
import { FixedClock } from '@/server/clock'
import { CFG, bed, persona, reservation, staff, stay, world } from './fixtures'

describe('overlaps (D-103: `to` is the departure day, exclusive; no `to` = open-ended)', () => {
  const w = (from: string, to?: string) => ({ from, to })
  it('detects a shared night', () => {
    expect(overlaps(w('2026-11-01', '2026-11-10'), w('2026-11-09', '2026-11-20'))).toBe(true)
    expect(overlaps(w('2026-11-01', '2026-11-10'), w('2026-11-05', '2026-11-06'))).toBe(true)
  })
  it('allows same-day turnover and back-to-back windows', () => {
    expect(overlaps(w('2026-11-01', '2026-11-10'), w('2026-11-10', '2026-11-20'))).toBe(false)
    expect(overlaps(w('2026-11-10', '2026-11-20'), w('2026-11-01', '2026-11-10'))).toBe(false)
    expect(overlaps(w('2026-11-01', '2026-11-10'), w('2026-11-11', '2026-11-20'))).toBe(false)
  })
  it('an open-ended window overlaps everything that departs after it starts', () => {
    expect(overlaps(w('2026-11-01'), w('2030-01-01', '2030-01-02'))).toBe(true)
    expect(overlaps(w('2026-11-01'), w('2026-10-01', '2026-10-31'))).toBe(false)
    expect(overlaps(w('2026-11-01'), w('2026-10-01', '2026-11-01'))).toBe(false)   // departs the day it arrives
    expect(overlaps(w('2026-11-01'), w('2026-10-01', '2026-11-02'))).toBe(true)
    expect(overlaps(w('2026-11-01'), w('2027-01-01'))).toBe(true)
  })
})

describe('claimPeriod (the database form of a window)', () => {
  it('is half-open [arrival, departure): the departure day is free for the next resident (D-103)', () => {
    expect(claimPeriod('2026-11-01', '2026-11-10')).toBe('[2026-11-01,2026-11-10)')
    expect(claimPeriod('2026-12-31', '2027-01-01')).toBe('[2026-12-31,2027-01-01)')
  })
  it('refuses a departure on or before arrival', () => {
    expect(() => claimPeriod('2026-11-10', '2026-11-10')).toThrow()
    expect(() => claimPeriod('2026-11-10', '2026-11-09')).toThrow()
  })
  it('has no upper bound for an open-ended stay', () => {
    expect(claimPeriod('2026-11-01')).toBe('[2026-11-01,)')
  })
})

describe('bedConflict: the bed is the allocation unit', () => {
  it('finds an active stay, then a reservation, and names who holds the bed', () => {
    const s = world({ stays: [stay({ end: '2026-11-30' })], staff: [staff({ name: 'Asha' })] })
    const hit = bedConflict(s, 'b1', { from: '2026-11-15', to: '2026-12-15' })
    expect(hit).toMatchObject({ kind: 'stay', who: 'Asha' })
    const s2 = world({ reservations: [reservation()] })
    expect(bedConflict(s2, 'b1', { from: '2026-10-25', to: '2026-11-05' })).toMatchObject({ kind: 'reservation' })
  })
  it('ignores ended stays, closed reservations and other beds', () => {
    const s = world({ stays: [stay({ status: 'Ended' })], reservations: [reservation({ status: 'Cancelled' }), reservation({ id: 'R2', bedId: 'b2' })] })
    expect(bedConflict(s, 'b1', { from: '2026-10-01', to: '2026-12-31' })).toBeNull()
  })
  it('lets a reservation be re-checked against itself (approval editing, transfer) via ignore', () => {
    const s = world({ reservations: [reservation()] })
    expect(bedConflict(s, 'b1', { from: '2026-10-20', to: '2026-10-31' }, { reservationId: 'R1' })).toBeNull()
  })
  it('an open-ended active stay conflicts with any later window', () => {
    const s = world({ stays: [stay()] })
    expect(bedConflict(s, 'b1', { from: '2030-01-01', to: '2030-01-31' })).not.toBeNull()
  })
})

describe('bedAllocatable', () => {
  it('refuses held, blocked, under-maintenance and archived beds with reason, owner and next action', () => {
    for (const [b, text] of [
      [bed({ heldBy: 'O1' }), /held by a bed offer/],
      [bed({ state: 'Blocked', reason: 'leak' }), /blocked: leak/],
      [bed({ state: 'UnderMaintenance' }), /under maintenance/],
      [bed({ state: 'Archived' }), /archived/],
    ] as const) {
      const r = bedAllocatable(world(), b)
      expect(r).not.toBeNull()
      expect(r!.reason).toMatch(text)
      expect(r!.owner).toBeTruthy()
      expect(r!.next).toBeTruthy()
    }
  })
  it('accepts Needs Cleaning and Occupied: readiness gates check-in, not reservations (D-18)', () => {
    expect(bedAllocatable(world(), bed({ state: 'NeedsCleaning' }))).toBeNull()
    expect(bedAllocatable(world(), bed({ state: 'Occupied' }))).toBeNull()
  })
})

describe('eligibility', () => {
  const s = world()
  it('passes a matching, graded, active person', () => {
    expect(eligibility(s, staff(), s.beds[0])).toEqual({ ok: true, reasons: [], exceptionable: false })
  })
  it('flags a gender mismatch and a low grade, both exceptionable', () => {
    const r = eligibility(s, staff({ gender: 'Male', grade: 1 }), s.beds[0])
    expect(r.ok).toBe(false)
    expect(r.reasons).toHaveLength(2)
    expect(r.exceptionable).toBe(true)
  })
  it('exceptions granted by a Policy Approver clear exactly that rule', () => {
    const r = eligibility(s, staff({ gender: 'Male', grade: 1, exceptions: ['gender'] }), s.beds[0])
    expect(r.reasons).toEqual([expect.stringMatching(/needs grade G3\+/)])
  })
  it('a Left employee is never eligible and cannot be excepted', () => {
    const r = eligibility(s, staff({ status: 'Left' }), s.beds[0])
    expect(r).toMatchObject({ ok: false, exceptionable: false })
  })
  it('gender rule can be switched off by configuration', () => {
    const open = world({ config: { ...CFG, genderStrict: false } })
    expect(eligibility(open, staff({ gender: 'Male' }), open.beds[0]).ok).toBe(true)
  })
  it('per-site grade override in config beats the site default', () => {
    const lowered = world({ config: { ...CFG, minGradeBySite: { site1: 1 } } })
    expect(eligibility(lowered, staff({ grade: 1 }), lowered.beds[0]).ok).toBe(true)
  })
})

describe('suggestBeds', () => {
  it('returns eligible, allocatable, conflict-free beds in scope; Available before Needs Cleaning', () => {
    const s = world({ reservations: [reservation({ bedId: 'b1' })] })
    const got = suggestBeds(s, staff(), { from: '2026-10-25', to: '2026-11-05' }, ['site1']).map(b => b.id)
    expect(got).toEqual(['b2', 'b3'])
  })
  it('respects the actor scope', () => {
    expect(suggestBeds(world(), staff(), { from: '2026-10-25' }, ['other-site'])).toEqual([])
    expect(suggestBeds(world(), staff(), { from: '2026-10-25' }, 'all')).toHaveLength(3)
  })
  it('skips beds held by an offer', () => {
    const s = world({ beds: [bed({ id: 'b1', heldBy: 'O1' }), bed({ id: 'b2', code: 'PV-V01-R1-B' })] })
    expect(suggestBeds(s, staff(), { from: '2026-10-25' }, 'all').map(b => b.id)).toEqual(['b2'])
  })
})

describe('approvalClock (reminds and escalates, never decides)', () => {
  // Wed 14 Oct 2026 09:42 UTC
  const clock = new FixedClock(Date.UTC(2026, 9, 14, 9, 42))
  const created = clock.nowMs()
  const at = (ms: number) => new FixedClock(created).advance(ms).nowMs()

  it('is within SLA before one full business day', () => {
    expect(approvalClock(created, at(DAY - 1), CFG)).toMatchObject({ bd: 0, level: 0, label: 'Within SLA' })
  })
  it('reminds at 1 business day, routes to backup at 2, escalates at 3 (SLA = 2)', () => {
    expect(approvalClock(created, at(DAY), CFG)).toMatchObject({ bd: 1, reminders: 1, level: 0, label: 'Reminded' })
    expect(approvalClock(created, at(2 * DAY), CFG)).toMatchObject({ bd: 2, level: 1, label: 'Routed to backup' })
    // Created Wed 09:42: Thu = 1, Fri = 2, the weekend adds nothing, Mon 09:42 = 3.
    expect(approvalClock(created, at(4 * DAY), CFG)).toMatchObject({ bd: 2, level: 1 })
    expect(approvalClock(created, at(5 * DAY), CFG)).toMatchObject({ bd: 3, level: 2, label: 'Escalated' })
  })
  it('weekends do not count: a Friday submission is still within 1 business day on Saturday and Sunday', () => {
    const friday = Date.UTC(2026, 9, 16, 15, 0)
    expect(approvalClock(friday, friday + 2 * DAY, CFG).bd).toBe(0)
    expect(approvalClock(friday, friday + 3 * DAY, CFG).bd).toBe(1)   // Monday 15:00
  })
  it('keeps escalating information only: the clock has no notion of an automatic decision', () => {
    const r = approvalClock(created, at(30 * DAY), CFG)
    expect(Object.keys(r).sort()).toEqual(['bd', 'label', 'level', 'reminders'])
    expect(r.level).toBe(2)
  })
})

describe('stayState', () => {
  const t = '2026-10-14'
  it('open-ended stays are ok', () => expect(stayState(stay(), t, CFG)).toBe('ok'))
  it('is ending within 7 days', () => {
    expect(stayState(stay({ end: '2026-10-21' }), t, CFG)).toBe('ending')
    expect(stayState(stay({ end: '2026-10-22' }), t, CFG)).toBe('ok')
  })
  it('is overdue from the day after the end date, escalated after the grace period', () => {
    expect(stayState(stay({ end: '2026-10-14' }), t, CFG)).toBe('ending')
    expect(stayState(stay({ end: '2026-10-13' }), t, CFG)).toBe('overdue')
    expect(stayState(stay({ end: '2026-10-11' }), t, CFG)).toBe('overdue')
    expect(stayState(stay({ end: '2026-10-10' }), t, CFG)).toBe('escalated')
  })
})

describe('resStatusView', () => {
  const r = reservation({ eta: 1_000_000 })
  it('Expected before the ETA, No-show after it, Not ready when the bed is not Available', () => {
    expect(resStatusView(r, 999_999, bed())).toBe('Expected')
    expect(resStatusView(r, 999_999, bed({ state: 'NeedsCleaning' }))).toBe('Not ready')
    expect(resStatusView(r, 1_000_001, bed())).toBe('No-show')
  })
  it('the no-show window is 24h after the arrival time, configured not hard-coded', () => {
    const arrival = Date.UTC(2026, 9, 20, 12)
    expect(resStatusView(reservation({ eta: arrival + CFG.noShowHours * HOUR }), arrival + 23 * HOUR)).toBe('Expected')
  })
})

describe('selfAction (D-26: no acting on your own record)', () => {
  it('blocks and says who decides instead', () => {
    const r = selfAction(persona({ staffId: 'E9' }), 'E9', 'approve')
    expect(r).toMatchObject({ ok: false, owner: expect.stringContaining('D-26') })
    expect(r!.reason).toContain("can't approve your own record")
  })
  it('lets other people through, and people without a staff record', () => {
    expect(selfAction(persona({ staffId: 'E9' }), 'E10', 'approve')).toBeNull()
    expect(selfAction(persona({ staffId: undefined }), 'E10', 'approve')).toBeNull()
  })
})

describe('bedPath', () => {
  it('builds the hierarchy label, skipping missing levels (villa has no building)', () => {
    const s = world()
    expect(bedPath(s, s.beds[0])).toBe('Palm Villas › Villa 01 › Room 1 › Bed A')
    const villa = world({ rooms: [{ id: 'r1', siteId: 'site1', name: 'Master', gender: 'Any' }] })
    expect(bedPath(villa, villa.beds[0])).toBe('Palm Villas › Master › Bed A')
  })
})
