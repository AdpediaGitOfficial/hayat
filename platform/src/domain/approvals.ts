/**
 * Approval clock (pure): reminder at 1 business day, backup at the SLA (2), escalation at SLA + 1 (3).
 * It only describes where an item is; nothing here, or anywhere that calls it, decides for a person.
 */
import { DAY } from './time'

export interface Calendar {
  /** 0 = Sunday ... 6 = Saturday */
  weekendDays: readonly number[]
  /** 'YYYY-MM-DD' */
  holidays: readonly string[]
}
export const DEFAULT_CALENDAR: Calendar = { weekendDays: [0, 6], holidays: [] }

const isBusinessDay = (ms: number, cal: Calendar) =>
  !cal.weekendDays.includes(new Date(ms).getUTCDay()) && !cal.holidays.includes(new Date(ms).toISOString().slice(0, 10))

/** Whole business days elapsed between two instants: a day counts once a full 24 h has passed and it was a business day. */
export function businessDaysElapsed(from: number, to: number, cal: Calendar = DEFAULT_CALENDAR): number {
  if (to <= from) return 0
  let n = 0
  let t = from
  while (t + DAY <= to) {
    t += DAY
    if (isBusinessDay(t, cal)) n++
  }
  return n
}

export type ApprovalLevel = 0 | 1 | 2
export interface ApprovalClock { businessDays: number; reminders: number; level: ApprovalLevel; label: 'Within SLA' | 'Reminded' | 'Routed to backup' | 'Escalated' }

export function approvalClock(createdAt: number, now: number, slaBusinessDays: number, cal: Calendar = DEFAULT_CALENDAR): ApprovalClock {
  const bd = businessDaysElapsed(createdAt, now, cal)
  const level: ApprovalLevel = bd >= slaBusinessDays + 1 ? 2 : bd >= slaBusinessDays ? 1 : 0
  const reminders = bd >= 1 ? Math.min(bd, slaBusinessDays + 1) : 0
  return { businessDays: bd, reminders, level, label: level === 2 ? 'Escalated' : level === 1 ? 'Routed to backup' : reminders ? 'Reminded' : 'Within SLA' }
}

/** D-46: a request whose arrival falls inside the approval SLA window is Urgent. */
export function isUrgent(arrivalDate: string, nowMs: number, slaBusinessDays: number): boolean {
  return (Date.parse(arrivalDate + 'T00:00:00Z') - nowMs) / DAY <= slaBusinessDays + 1
}
