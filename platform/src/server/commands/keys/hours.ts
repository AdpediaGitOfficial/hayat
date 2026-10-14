/**
 * Key desk office hours (P-03, PROPOSED, pending client sign-off; settings `keys.office_hours` per site and `keys.enforce_office_hours`).
 *
 * Two separate things, never confused:
 *  - the FLAG: every key or asset movement records whether it happened outside the site's office hours (`handover_event.after_hours`,
 *    and the audit row). It is a fact in the trail and restricts nobody;
 *  - the RULE (only when `keys.enforce_office_hours` is on): outside the hours Reception is refused. Night Keys holders
 *    (`keys.issue_return_night`) and the administrators (`keys.manage`) are always allowed.
 *
 * Time is the SITE's local time (the site's time zone), never the server's. The window is [from, to): `from` is inside, `to` is
 * outside. When `to` is not later than `from` the window spans midnight (22:00 to 06:00).
 */
import { eq } from 'drizzle-orm'
import { site } from '@/server/db/schema'
import type { CommandContext, Tx } from '@/server/command/context'
import { failure, type Failure } from '@/server/command/result'
import { getConfig } from '@/server/config/registry'
import { decide } from '@/server/policy'

export interface OfficeHours { from: string; to: string }
export interface DeskHours extends OfficeHours { afterHours: boolean; timeZone: string }

/** Seconds since local midnight in the zone (DST-safe: the zone database decides what the local clock reads). */
export function localSecondsOfDay(now: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(now)
  const get = (t: string) => Number(parts.find(p => p.type === t)?.value ?? 0)
  return get('hour') * 3600 + get('minute') * 60 + get('second')
}

const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5))

/** True when `now` is outside the office hours at the zone. `from` inclusive, `to` exclusive; to <= from spans midnight. */
export function isAfterHours(now: Date, timeZone: string, hours: OfficeHours): boolean {
  const t = localSecondsOfDay(now, timeZone)
  const from = minutes(hours.from) * 60, to = minutes(hours.to) * 60
  const inside = from < to ? t >= from && t < to : t >= from || t < to
  return !inside
}

/** The site's zone and office hours (per-site setting, else the global default) and whether `now` is outside them. */
export async function deskHours(q: Tx, now: Date, siteId: string): Promise<DeskHours> {
  const [s] = await q.select({ tz: site.timeZone }).from(site).where(eq(site.id, siteId)).limit(1)
  const timeZone = s?.tz ?? 'UTC'
  const hours = await getConfig(q, 'keys.office_hours', siteId)
  return { from: hours.from, to: hours.to, timeZone, afterHours: isAfterHours(now, timeZone, hours) }
}

/**
 * The gate every movement passes after it knows the actor may touch the site. Returns the facts to record, or the refusal.
 * With the rule off it never refuses.
 */
export async function movementHours(c: CommandContext, siteId: string): Promise<DeskHours | Failure> {
  const h = await deskHours(c.tx, c.now, siteId)
  if (!h.afterHours) return h
  if (!(await getConfig(c.tx, 'keys.enforce_office_hours', siteId))) return h
  const exempt = (['keys.issue_return_night', 'keys.manage'] as const).some(a => decide(c.actor, a, { siteId }).allowed)
  if (exempt) return h
  return failure('forbidden', `The key desk is closed: office hours are ${h.from} to ${h.to} (site time). Reception cannot hand out or take back keys and assets now`, {
    owner: 'Security with Night Keys, or an Accommodation Admin',
    next: `Ask Security (Night Keys) or an Accommodation Admin to do it, or come back from ${h.from}`,
    detail: { reason: 'outside_office_hours', from: h.from, to: h.to, timeZone: h.timeZone, proposal: 'P-03 (proposed, pending client sign-off)' },
  })
}
export const isRefusal = (x: DeskHours | Failure): x is Failure => 'ok' in x
