import { useEffect, useState, useSyncExternalStore } from 'react'

/** Demo clock: starts Wed 14 Oct 2026 09:42, runs in real time, and can be jumped forward. */
export const BASE = Date.UTC(2026, 9, 14, 9, 42, 0)
export const HOUR = 3600_000
export const DAY = 24 * HOUR

let offset = 0
let startReal = Date.now()
const subs = new Set<() => void>()
export const nowMs = () => BASE + offset + (Date.now() - startReal)
export function jump(ms: number) {
  offset += ms
  subs.forEach(f => f())
}
/** Reset the demo clock to its starting moment (used together with resetting the data). */
export function resetClock() {
  offset = 0
  startReal = Date.now()
  subs.forEach(f => f())
}
export function onJump(f: () => void) {
  subs.add(f)
  return () => subs.delete(f)
}
let epoch = 0
subs.add(() => { epoch++ })

/** Re-renders every second with the current demo time. */
export function useNow(intervalMs = 1000) {
  const [n, setN] = useState(nowMs())
  useEffect(() => {
    const t = setInterval(() => setN(nowMs()), intervalMs)
    const off = onJump(() => setN(nowMs()))
    return () => { clearInterval(t); off() }
  }, [intervalMs])
  return n
}
export function useJumpEpoch() {
  return useSyncExternalStore(onJump, () => epoch)
}

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const p2 = (n: number) => String(n).padStart(2, '0')

export const dateStr = (ms: number) => new Date(ms).toISOString().slice(0, 10)
export const parseDate = (s: string) => Date.parse(s + 'T00:00:00Z')
export const addDays = (s: string, n: number) => dateStr(parseDate(s) + n * DAY)
export const today = (ms = nowMs()) => dateStr(ms)
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
export function fmtDur(ms: number) {
  const neg = ms < 0
  let s = Math.floor(Math.abs(ms) / 1000)
  const d = Math.floor(s / 86400); s -= d * 86400
  const h = Math.floor(s / 3600); s -= h * 3600
  const m = Math.floor(s / 60); s -= m * 60
  const body = d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${p2(m)}m` : `${m}m ${p2(s)}s`
  return (neg ? '-' : '') + body
}
export function dayDiff(a: string, b: string) {
  return Math.round((parseDate(b) - parseDate(a)) / DAY)
}
/** Whole business days (Mon–Fri) elapsed between two timestamps. Working week is configurable in a real build. */
export function businessDaysBetween(from: number, to: number) {
  if (to <= from) return 0
  let n = 0
  let t = from
  while (t + DAY <= to) {
    t += DAY
    const dow = new Date(t).getUTCDay()
    if (dow !== 0 && dow !== 6) n++
  }
  return n
}
export const greeting = (ms: number) => {
  const h = new Date(ms).getUTCHours()
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'
}
