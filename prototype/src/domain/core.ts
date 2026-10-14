import { useSyncExternalStore } from 'react'
import type { Bed, BedState, Fail, Notification, Persona, Res, State } from './types'
import { buildSeed } from './seed'
import { nowMs, resetClock } from './time'
import { bedById, staffById } from './rules'

/* ============ external store with all-or-nothing commits ============ */
let state: State = buildSeed()
const listeners = new Set<() => void>()
const emit = () => listeners.forEach(f => f())
export const getState = () => state
export function useAppState(): State {
  return useSyncExternalStore(f => { listeners.add(f); return () => listeners.delete(f) }, () => state)
}
export function resetState() { resetClock(); state = buildSeed(); emit() }

/** Every business operation runs on a clone and is committed only if it fully succeeds. A failed transfer therefore leaves the resident where they were. */
export function run<T = void>(fn: (d: State) => Res<T>): Res<T> {
  const d = structuredClone(state)
  let r: Res<T>
  try { r = fn(d) } catch (e) { r = { ok: false, reason: 'Unexpected error: ' + (e as Error).message } }
  if (r.ok) { state = d; emit() }
  return r
}
export const uid = (d: State, p: string) => `${p}${++d.seq}`
export const fail = (reason: string, owner?: string, next?: string): Fail => ({ ok: false, reason, owner, next })
export const ok = <T = void>(msg?: string, data?: T): Res<T> => ({ ok: true, msg, data })
export const log = (d: State, actor: Persona | string, action: string, detail: string) =>
  d.audit.unshift({ id: uid(d, 'A'), at: nowMs(), actor: typeof actor === 'string' ? actor : actor.name, action, detail })
export const guard = (...fs: (Fail | null)[]) => fs.find(Boolean) ?? null
export const reauth = (confirm: boolean | undefined, what: string): Fail | null =>
  confirm ? null : fail(`Re-enter your password to ${what}`, 'High-risk action (D-03)', 'Tick “I confirm” to continue')
export const fullName = (d: State, id: string) => staffById(d, id)?.name ?? id
export const bedCode = (d: State, id: string) => bedById(d, id)?.code ?? id

export function openCleaning(d: State, bedId: string) {
  d.cleaning.push({ id: uid(d, 'H'), bedId, status: 'Open', createdAt: nowMs() })
}
export function setBed(d: State, bed: Bed, st: BedState, reason?: string) {
  bed.state = st; bed.since = nowMs(); bed.reason = reason
}

/** Queue a notification. In-app is immediate; email goes through a delivery pipeline (queued → sent → delivered, retries, failed).
    Identical notifications to the same recipient inside the dedupe window are dropped, so a retried event never double-notifies. */
export type NotifyInput = Omit<Notification, 'id' | 'at' | 'emailStatus' | 'attempts' | 'nextAttemptAt' | 'lastError' | 'sentAt' | 'dedupeKey'> & { dedupeKey?: string }
export function notify(d: State, n: NotifyInput, now = nowMs()): Notification | null {
  const key = n.dedupeKey ?? `${n.toStaffId ?? n.toRole}|${n.text}`
  if (d.notifications.some(x => x.dedupeKey === key && now - x.at < d.config.notificationDedupeMinutes * 60000)) return null
  // staff without an email address are reached in-app (and by Reception follow-up), never "emailed"
  const email = !!n.email && (!n.toStaffId || !!staffById(d, n.toStaffId)?.email)
  const rec: Notification = { ...n, email, id: uid(d, 'N'), at: now, dedupeKey: key, attempts: 0, emailStatus: email ? 'queued' : undefined, nextAttemptAt: email ? now : undefined }
  d.notifications.unshift(rec)
  return rec
}

/** Time-driven rules register here. They may remind, escalate and apply the specified expiries. They never approve, reject, move or check out anyone. */
export type TickCtx = { d: State; now: number; note: (n: NotifyInput) => void; touch: () => void }
const tickSteps: ((c: TickCtx) => void)[] = []
export const registerTick = (f: (c: TickCtx) => void) => { tickSteps.push(f) }
export function runTick() {
  const now = nowMs()
  const d = structuredClone(state)
  let changed = false
  const c: TickCtx = { d, now, touch: () => { changed = true }, note: n => { if (notify(d, n, now)) changed = true } }
  for (const f of tickSteps) f(c)
  if (changed) { state = d; emit() }
}
export const tickStepCount = () => tickSteps.length
