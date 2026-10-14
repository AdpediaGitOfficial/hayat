/**
 * Pure rules of the exit and clearance package: no database, safe to import from the browser bundle as well.
 *
 * The item states are the ones in SRS section 7 and D-71: Open, Done, Waived, Outstanding. A key or asset item has no
 * state of its own that anyone can type in: it is read LIVE from the keys register (a held item is Open, a returned or
 * retired one is Done, a lost or damaged one is Outstanding and belongs to the Accommodation Admin, D-73).
 */
import type { Calendar } from '@/domain/approvals'
import { addDays, dateStr, parseDate } from '@/domain/time'
import type { ClearanceItemStatus, ClearanceOwner, ClearanceStatus } from '@/server/db/schema.exit'
import type { HandoverStatus } from '@/server/db/schema.stage3'

export const OWNER_LABEL: Record<ClearanceOwner, string> = {
  Reception: 'Reception',
  Maintenance: 'Maintenance Coordinator',
  AA: 'Accommodation Admin',
}
export const STATUS_LABEL: Record<ClearanceItemStatus, string> = { open: 'Open', done: 'Done', waived: 'Waived', outstanding: 'Outstanding' }
export const CASE_STATUS_LABEL: Record<ClearanceStatus, string> = { open: 'Open', in_progress: 'In progress', pending_items: 'Pending items', cleared: 'Cleared' }

/** The day `n` business days after `from` ('YYYY-MM-DD'), by the site's working week and holidays. n = 0 is `from` itself. */
export function addBusinessDays(from: string, n: number, cal: Calendar): string {
  let d = from
  let left = n
  let guard = 0
  while (left > 0 && guard++ < 3660) {
    d = addDays(d, 1)
    const t = parseDate(d)
    if (!cal.weekendDays.includes(new Date(t).getUTCDay()) && !cal.holidays.includes(dateStr(t))) left--
  }
  return d
}

/** Whole business days after `due` up to and including `today` (0 while today is not later than the due date). */
export function businessDaysAfter(due: string, today: string, cal: Calendar): number {
  let n = 0
  let d = due
  let guard = 0
  while (d < today && guard++ < 3660) {
    d = addDays(d, 1)
    const t = parseDate(d)
    if (!cal.weekendDays.includes(new Date(t).getUTCDay()) && !cal.holidays.includes(dateStr(t))) n++
  }
  return n
}

export interface ItemFacts {
  kind: 'checklist' | 'handover'
  mandatory: boolean
  owner: ClearanceOwner
  status: ClearanceItemStatus
  /** The key or asset as the register shows it right now (handover items only). */
  live?: { status: HandoverStatus; holderStaffId: string | null }
}

/** What the item is NOW. A waiver is final; a handover item follows the register; a checklist item is what was recorded. */
export function effectiveStatus(i: ItemFacts, personStaffId: string): ClearanceItemStatus {
  if (i.status === 'waived') return 'waived'
  if (i.kind === 'checklist' || !i.live) return i.status
  const { status, holderStaffId } = i.live
  if (status === 'retired' || status === 'in_cabinet') return 'done'
  if (holderStaffId !== null && holderStaffId !== personStaffId) return 'done' // handed on to someone else: no longer theirs
  if (status === 'lost' || status === 'damaged') return 'outstanding'
  // still issued to the person: Open, unless somebody recorded that it cannot be handed back for now
  return i.status === 'outstanding' ? 'outstanding' : 'open'
}

/** Lost or damaged keys and assets belong to the Accommodation Admin until they are resolved or waived (D-73). */
export function effectiveOwner(i: ItemFacts): ClearanceOwner {
  if (i.kind === 'handover' && i.live && (i.live.status === 'lost' || i.live.status === 'damaged')) return 'AA'
  return i.owner
}

/** Lost or damaged: never markable as returned (D-73). */
export const isLostOrDamaged = (i: ItemFacts) => i.kind === 'handover' && !!i.live && (i.live.status === 'lost' || i.live.status === 'damaged')

/** The case status from its items: nothing done yet = open; something done = in progress; a mandatory item stuck = pending items. */
export function deriveCaseStatus(items: readonly { mandatory: boolean; effective: ClearanceItemStatus }[]): Exclude<ClearanceStatus, 'cleared'> {
  if (items.some(i => i.mandatory && i.effective === 'outstanding')) return 'pending_items'
  if (items.some(i => i.effective === 'done' || i.effective === 'waived')) return 'in_progress'
  return 'open'
}

export interface Blocker { itemId: string; label: string; status: ClearanceItemStatus; owner: string; next: string }

export function nextActionFor(i: { kind: 'checklist' | 'handover'; effective: ClearanceItemStatus; owner: ClearanceOwner; lostOrDamaged: boolean }): string {
  if (i.kind === 'handover') {
    if (i.lostOrDamaged) return 'Resolve the loss or damage in Keys & assets, or ask a Policy Approver to waive it with a reason and evidence'
    return i.effective === 'outstanding' ? 'Record the return in Keys & assets, or ask a Policy Approver to waive it' : 'Record the return in Keys & assets'
  }
  if (i.effective === 'outstanding') return `${OWNER_LABEL[i.owner]} to finish it, or a Policy Approver to waive it with a reason and evidence`
  return i.owner === 'Maintenance' ? 'The Maintenance Coordinator completes the inspection on the former employee\'s behalf' : `${OWNER_LABEL[i.owner]} completes it on the former employee's behalf`
}

/** Mandatory items that stop the case from closing: Open or Outstanding. Done and Waived do not. */
export function closeBlockers(items: readonly { id: string; label: string; kind: 'checklist' | 'handover'; mandatory: boolean; effective: ClearanceItemStatus; owner: ClearanceOwner; lostOrDamaged: boolean }[]): Blocker[] {
  return items
    .filter(i => i.mandatory && (i.effective === 'open' || i.effective === 'outstanding'))
    .map(i => ({ itemId: i.id, label: i.label, status: i.effective, owner: OWNER_LABEL[i.owner], next: nextActionFor(i) }))
}
