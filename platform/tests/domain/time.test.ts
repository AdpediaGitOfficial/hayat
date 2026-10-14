import { describe, expect, it } from 'vitest'
import {
  DAY, HOUR, addDays, businessDaysBetween, dateStr, dayDiff, fmtDate, fmtDateLong, fmtDateTime, fmtDur, fmtTime, greeting, parseDate, today,
} from '@/domain/time'
import { FixedClock, systemClock } from '@/server/clock'

// Wed 14 Oct 2026 09:42 UTC
const WED = Date.UTC(2026, 9, 14, 9, 42)

describe('dates', () => {
  it('round-trips ISO dates and adds days across month and year ends', () => {
    expect(dateStr(WED)).toBe('2026-10-14')
    expect(parseDate('2026-10-14')).toBe(Date.UTC(2026, 9, 14))
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01')
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29')
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
    expect(today(WED)).toBe('2026-10-14')
  })
  it('counts calendar days between dates, negative when going back', () => {
    expect(dayDiff('2026-10-14', '2026-10-21')).toBe(7)
    expect(dayDiff('2026-10-21', '2026-10-14')).toBe(-7)
    expect(dayDiff('2026-10-14', '2026-10-14')).toBe(0)
  })
})

describe('formatting', () => {
  it('formats dates and times in UTC', () => {
    expect(fmtDate(WED)).toBe('Wed 14 Oct')
    expect(fmtDate('2026-10-14')).toBe('Wed 14 Oct')
    expect(fmtDateLong('2026-12-25')).toBe('Fri 25 Dec 2026')
    expect(fmtTime(WED)).toBe('09:42')
    expect(fmtDateTime(WED)).toBe('Wed 14 Oct, 09:42')
  })
  it('formats durations for timers', () => {
    expect(fmtDur(48 * HOUR)).toBe('2d 0h')
    expect(fmtDur(26 * HOUR + 5 * 60_000)).toBe('1d 2h')
    expect(fmtDur(3 * HOUR + 5 * 60_000)).toBe('3h 05m')
    expect(fmtDur(9 * 60_000 + 30_000)).toBe('9m 30s')
    expect(fmtDur(-5_000)).toBe('-0m 05s')
    expect(fmtDur(0)).toBe('0m 00s')
  })
  it('greets by time of day', () => {
    expect(greeting(Date.UTC(2026, 9, 14, 8))).toBe('Good morning')
    expect(greeting(Date.UTC(2026, 9, 14, 12))).toBe('Good afternoon')
    expect(greeting(Date.UTC(2026, 9, 14, 18))).toBe('Good evening')
  })
})

describe('businessDaysBetween', () => {
  it('is 0 when nothing or less than a full day has elapsed, and when time runs backwards', () => {
    expect(businessDaysBetween(WED, WED)).toBe(0)
    expect(businessDaysBetween(WED, WED + DAY - 1)).toBe(0)
    expect(businessDaysBetween(WED, WED - DAY)).toBe(0)
  })
  it('counts a day when 24 full hours have passed, on the exact boundary', () => {
    expect(businessDaysBetween(WED, WED + DAY)).toBe(1)
  })
  it('skips Saturday and Sunday', () => {
    const fri = Date.UTC(2026, 9, 16, 9, 0)
    expect(businessDaysBetween(fri, fri + 3 * DAY)).toBe(1)   // Mon
    expect(businessDaysBetween(fri, fri + 7 * DAY)).toBe(5)   // Fri..Fri = Mon-Fri
    expect(businessDaysBetween(WED, WED + 14 * DAY)).toBe(10)
  })
  it('honours a different working week (e.g. Sun-Thu)', () => {
    const sunThu = [0, 1, 2, 3, 4]
    const thu = Date.UTC(2026, 9, 15, 9, 0)
    expect(businessDaysBetween(thu, thu + 3 * DAY, sunThu)).toBe(1)   // Fri, Sat skipped; Sun counts
  })
})

describe('Clock', () => {
  it('FixedClock stays put until advanced, and can go back or be reset', () => {
    const c = new FixedClock(WED)
    expect(c.nowMs()).toBe(WED)
    expect(c.now().toISOString()).toBe('2026-10-14T09:42:00.000Z')
    c.advance(HOUR)
    expect(c.nowMs()).toBe(WED + HOUR)
    expect(c.advance(2 * HOUR).advance(-HOUR).nowMs()).toBe(WED + 2 * HOUR)
    c.set('2027-01-01T00:00:00Z')
    expect(c.nowMs()).toBe(Date.UTC(2027, 0, 1))
  })
  it('accepts a Date or ISO string and rejects garbage', () => {
    expect(new FixedClock(new Date(WED)).nowMs()).toBe(WED)
    expect(new FixedClock('2026-10-14T09:42:00Z').nowMs()).toBe(WED)
    expect(() => new FixedClock('not a date')).toThrow(/invalid/)
  })
  it('defaults to the demo start moment so tests are deterministic', () => {
    expect(new FixedClock().nowMs()).toBe(WED)
  })
  it('systemClock follows the real clock', () => {
    const before = Date.now()
    const t = systemClock.nowMs()
    expect(t).toBeGreaterThanOrEqual(before)
    expect(systemClock.now().getTime()).toBeGreaterThanOrEqual(t)
  })
  it('lets a timer boundary be tested to the millisecond: an offer expires exactly 48h after delivery', () => {
    const c = new FixedClock(WED)
    const expiresAt = c.nowMs() + 48 * HOUR
    c.advance(48 * HOUR - 1)
    expect(c.nowMs() < expiresAt).toBe(true)
    c.advance(1)
    expect(c.nowMs() >= expiresAt).toBe(true)
  })
})
