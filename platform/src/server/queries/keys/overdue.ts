/**
 * Overdue is COMPUTED, never stored (D-73): an issued item is overdue from the first day on which ANY of these holds:
 *  - it is held past its `due_back` date (overdue from the day after),
 *  - its holder has Left (overdue at once: they cannot be at the desk, Reception returns it on their behalf),
 *  - its holder has no stay that occupies a bed and their last stay ended (checked out) MORE than `keys.overdue_grace_days`
 *    days ago (grace 1: checked out on the 14th, overdue from the 16th).
 * "Today" is the site's own calendar day. Nothing here changes anything; the sweep only reminds.
 */
import { and, inArray, isNull } from 'drizzle-orm'
import { staffProfile, stay } from '@/server/db/schema'
import type { Db } from '@/server/db/client'
import { OCCUPYING_STAY_STATUSES } from '@/domain/enums'
import { addDays, DAY, parseDate } from '@/domain/time'

export type OverdueReason = 'due_date' | 'left' | 'departed'

export interface HolderFacts { left: boolean; leftAt: Date | null; occupying: boolean; lastEnded: Date | null }
export interface Overdue { overdue: boolean; since: string | null; reason: OverdueReason | null; daysOver: number }
export const NOT_OVERDUE: Overdue = { overdue: false, since: null, reason: null, daysOver: 0 }

/** 'YYYY-MM-DD' of an instant on the site's calendar. */
export function localDate(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at)
}
export const dayDiff = (a: string, b: string) => Math.round((parseDate(a) - parseDate(b)) / DAY)

export function overdueState(a: { status: string; dueBack: string | null; timeZone: string; now: Date; graceDays: number; holder: HolderFacts | undefined }): Overdue {
  if (a.status !== 'issued') return NOT_OVERDUE
  const today = localDate(a.now, a.timeZone)
  const candidates: { since: string; reason: OverdueReason }[] = []
  if (a.dueBack) candidates.push({ since: addDays(a.dueBack, 1), reason: 'due_date' })
  const h = a.holder
  if (h?.left) candidates.push({ since: h.leftAt ? localDate(h.leftAt, a.timeZone) : today, reason: 'left' })
  if (h && !h.occupying && h.lastEnded) candidates.push({ since: addDays(localDate(h.lastEnded, a.timeZone), a.graceDays + 1), reason: 'departed' })
  const due = candidates.filter(x => x.since <= today).sort((x, y) => x.since.localeCompare(y.since))
  if (due.length === 0) return NOT_OVERDUE
  return { overdue: true, since: due[0].since, reason: due[0].reason, daysOver: dayDiff(today, due[0].since) }
}

export const overdueText = (o: Overdue, a: { dueBack: string | null; lastEnded?: string | null }) =>
  o.reason === 'due_date' ? `was due back on ${a.dueBack}` : o.reason === 'left' ? 'the holder has left' : o.reason === 'departed' ? `the holder checked out${a.lastEnded ? ' on ' + a.lastEnded : ''}` : ''

/** What the rules need to know about the people holding items: their employment and whether a stay still occupies a bed. */
export async function loadHolderFacts(db: Pick<Db, 'select'>, staffIds: string[]): Promise<Map<string, HolderFacts>> {
  const ids = [...new Set(staffIds)]
  const out = new Map<string, HolderFacts>()
  if (ids.length === 0) return out
  const people = await db.select({ id: staffProfile.id, status: staffProfile.employmentStatus, leftAt: staffProfile.leftAt }).from(staffProfile).where(inArray(staffProfile.id, ids))
  for (const p of people) out.set(p.id, { left: p.status === 'left', leftAt: p.leftAt, occupying: false, lastEnded: null })
  const stays = await db.select({ staffId: stay.staffId, status: stay.status, checkedOutAt: stay.checkedOutAt }).from(stay).where(and(inArray(stay.staffId, ids), isNull(stay.archivedAt)))
  for (const s of stays) {
    const f = out.get(s.staffId)
    if (!f) continue
    if ((OCCUPYING_STAY_STATUSES as readonly string[]).includes(s.status)) f.occupying = true
    else if (s.checkedOutAt && (!f.lastEnded || s.checkedOutAt > f.lastEnded)) f.lastEnded = s.checkedOutAt
  }
  return out
}
