/**
 * Pure rules for check-in, no-show, end-of-stay and overdue handling (WP-F). No I/O and no clock: callers pass `now`
 * and the site-local `today`. The same functions drive the commands, the sweeps, the queries and the screens, so
 * the badge a person sees is the rule the server enforces. Ported from the prototype's stayState() and resStatusView().
 *
 * Dates are 'YYYY-MM-DD'. A stay's end is its DEPARTURE DAY (D-103, end-exclusive).
 */
import { addDays, dayDiff, HOUR } from '@/domain/time'

/* ---------------- no-show (D-58) ---------------- */

/**
 * A reservation lapses when now is AFTER eta + no_show_hours (x2 once the Accommodation Admin has extended it).
 * Exactly at the deadline it is still valid: "24h after the planned arrival" means strictly more than 24h.
 */
export function noShowDeadlineMs(etaMs: number, noShowHours: number, extended: boolean): number {
  return etaMs + noShowHours * (extended ? 2 : 1) * HOUR
}
export const isNoShow = (nowMs: number, etaMs: number, noShowHours: number, extended: boolean): boolean =>
  nowMs > noShowDeadlineMs(etaMs, noShowHours, extended)

/* ---------------- arrivals ---------------- */

export type ArrivalView = 'Expected' | 'Not ready' | 'No-show'
/**
 * What Reception sees for a reservation still waiting to check in:
 *  - No-show   the no-show window has passed (the sweep will release the hold),
 *  - Not ready the arrival day has come but the bed is not Available yet (cleaning, inspection, previous resident),
 *  - Expected  otherwise. A bed that is still being cleaned for a LATER arrival is fine: readiness gates check-in only (D-18).
 */
export function arrivalView(o: { nowMs: number; etaMs: number; noShowHours: number; extended: boolean; arrival: string; today: string; bedState: string }): ArrivalView {
  if (isNoShow(o.nowMs, o.etaMs, o.noShowHours, o.extended)) return 'No-show'
  if (o.arrival <= o.today && o.bedState !== 'available') return 'Not ready'
  return 'Expected'
}

/** Why a bed cannot be checked into yet, who owns that and what to do (D-93). Undefined when the bed is ready. */
export function readinessBlock(bed: { code: string; state: string; stateReason?: string | null }): { reason: string; code: 'bed_unavailable' | 'bed_not_ready' | 'bed_occupied'; owner: string; next: string } | undefined {
  switch (bed.state) {
    case 'available': return undefined
    case 'occupied':
      return { code: 'bed_occupied', reason: `Bed ${bed.code} is still occupied by the previous resident`, owner: 'Reception', next: 'Process the previous resident’s checkout, wait for cleaning and the final inspection, then check in. Or ask the Accommodation Admin to move the arrival to another bed' }
    case 'needs_cleaning':
      return { code: 'bed_not_ready', reason: `Bed ${bed.code} is not ready: it needs cleaning`, owner: 'Housekeeping', next: 'Wait for cleaning and the final inspection, then check in. Or ask the Accommodation Admin to move the reservation to a ready bed' }
    case 'inspection_required':
      return { code: 'bed_not_ready', reason: `Bed ${bed.code} is not ready: it is waiting for the final inspection`, owner: 'Final inspection holder', next: 'Wait for the final inspection to pass, then check in. Or ask the Accommodation Admin to move the reservation to a ready bed' }
    case 'blocked':
    case 'under_maintenance':
      return { code: 'bed_unavailable', reason: `Bed ${bed.code} is ${bed.state === 'blocked' ? 'blocked' : 'under maintenance'}${bed.stateReason ? `: ${bed.stateReason}` : ''}`, owner: 'Maintenance Coordinator', next: 'Unblock the bed, or ask the Accommodation Admin to move the reservation to another bed' }
    default:
      return { code: 'bed_unavailable', reason: `Bed ${bed.code} is ${bed.state}`, owner: 'Accommodation Admin', next: 'Ask the Accommodation Admin to move the reservation to another bed' }
  }
}

/* ---------------- end of stay (D-55, D-56) ---------------- */

export type StayFlag = 'ok' | 'ending' | 'overdue' | 'escalated'
export interface StayFlagInfo { flag: StayFlag; daysLeft: number | null; daysOver: number }

/**
 * `end` is the departure day. Overdue is flagged on day 1 after it (D-56); escalated to the Policy Approver once the
 * overdue days exceed the grace (default 3). Nothing here ever checks anyone out. `endingWithin` is the "ending soon" badge window.
 */
export function stayFlag(end: string | null, today: string, graceDays: number, endingWithin = 7): StayFlagInfo {
  if (!end) return { flag: 'ok', daysLeft: null, daysOver: 0 }
  const over = dayDiff(end, today)
  if (over > graceDays) return { flag: 'escalated', daysLeft: 0, daysOver: over }
  if (over >= 1) return { flag: 'overdue', daysLeft: 0, daysOver: over }
  const left = dayDiff(today, end)
  return { flag: left <= endingWithin ? 'ending' : 'ok', daysLeft: left, daysOver: 0 }
}

/**
 * Which end-of-stay reminder is due (D-55: 14, 7 and 1 days before, configurable). Returns the SMALLEST configured
 * "days before" that has been reached, so a sweep that starts late sends the one reminder that still matters instead
 * of a burst of stale ones. Undefined when none is due yet, or the end has passed (the overdue rules take over).
 */
export function endReminderDue(end: string | null, today: string, daysBefore: readonly number[]): number | undefined {
  if (!end || today >= end) return undefined
  const left = dayDiff(today, end)
  const reached = daysBefore.filter(d => left <= d)
  return reached.length ? Math.min(...reached) : undefined
}

/* ---------------- extension (D-57) ---------------- */

export function extensionSize(currentEnd: string, newEnd: string, policyDays: number): { addedDays: number; beyondPolicy: boolean } {
  const addedDays = dayDiff(currentEnd, newEnd)
  return { addedDays, beyondPolicy: addedDays > policyDays }
}

export { addDays, dayDiff }
