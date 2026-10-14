/**
 * Pure date/time helpers ported from the prototype (src/domain/time.ts), minus the React hooks and the
 * mutable demo clock. Nothing here reads the system time: callers pass `now` from an injected Clock
 * (src/server/clock.ts), which is what makes reminder and SLA boundaries testable.
 * Everything is UTC; display in the site time zone is a UI concern (G-01).
 */

export const HOUR = 3600_000
export const DAY = 24 * HOUR

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const p2 = (n: number) => String(n).padStart(2, '0')

/** 'YYYY-MM-DD' (UTC) of a timestamp. */
export const dateStr = (ms: number) => new Date(ms).toISOString().slice(0, 10)
export const parseDate = (s: string) => Date.parse(s + 'T00:00:00Z')
export const addDays = (s: string, n: number) => dateStr(parseDate(s) + n * DAY)
export const today = (nowMs: number) => dateStr(nowMs)

export function fmtDate(x: number | string) {
  const d = new Date(typeof x === 'string' ? parseDate(x) : x)
  return `${DOW[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]}`
}
export function fmtDateLong(x: number | string) {
  const d = new Date(typeof x === 'string' ? parseDate(x) : x)
  return `${fmtDate(x)} ${d.getUTCFullYear()}`
}
export function fmtTime(ms: number) {
  const d = new Date(ms)
  return `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`
}
export const fmtDateTime = (ms: number) => `${fmtDate(ms)}, ${fmtTime(ms)}`

/** "2d 3h", "4h 05m", "9m 30s"; negative durations get a leading minus. */
export function fmtDur(ms: number) {
  const neg = ms < 0
  let s = Math.floor(Math.abs(ms) / 1000)
  const d = Math.floor(s / 86400); s -= d * 86400
  const h = Math.floor(s / 3600); s -= h * 3600
  const m = Math.floor(s / 60); s -= m * 60
  const body = d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${p2(m)}m` : `${m}m ${p2(s)}s`
  return (neg ? '-' : '') + body
}

/** Whole calendar days from date a to date b (negative if b is earlier). */
export function dayDiff(a: string, b: string) {
  return Math.round((parseDate(b) - parseDate(a)) / DAY)
}

/** Monday to Friday. The working week and the holiday calendar become configuration in Stage 1 (G-01). */
export const DEFAULT_WORKING_DAYS: readonly number[] = [1, 2, 3, 4, 5]

/** Whole business days elapsed between two timestamps (a business day counts once a full 24h has passed on it). */
export function businessDaysBetween(from: number, to: number, workingDays: readonly number[] = DEFAULT_WORKING_DAYS) {
  if (to <= from) return 0
  let n = 0
  let t = from
  while (t + DAY <= to) {
    t += DAY
    if (workingDays.includes(new Date(t).getUTCDay())) n++
  }
  return n
}

export const greeting = (ms: number) => {
  const h = new Date(ms).getUTCHours()
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'
}
