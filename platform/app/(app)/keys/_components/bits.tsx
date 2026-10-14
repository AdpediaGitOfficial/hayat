/** Small server-safe pieces shared by the keys screens: the status chip, the overdue badge, readable labels. */
import { Badge, type Tone } from '@/ui'
import { fmtDate } from '@/domain/time'
import type { ItemRow } from '@/server/queries/keys/items'
import type { Overdue } from '@/server/queries/keys/overdue'

const CHIP: Record<ItemRow['status'], { tone: Tone; label: string }> = {
  in_cabinet: { tone: 'info', label: 'In cabinet' },
  issued: { tone: 'brand', label: 'Issued' },
  lost: { tone: 'danger', label: 'Lost' },
  damaged: { tone: 'warning', label: 'Damaged' },
  retired: { tone: 'neutral', label: 'Retired' },
}

export function StatusChip({ status }: { status: ItemRow['status'] }) {
  const c = CHIP[status]
  return <Badge tone={c.tone}>{c.label}</Badge>
}

export function OverdueBadge({ o }: { o: Overdue }) {
  if (!o.overdue || !o.since) return null
  const why = o.reason === 'left' ? 'holder has left' : o.reason === 'departed' ? 'holder checked out' : 'past due date'
  return <Badge tone="danger">Overdue · {why}{o.daysOver > 0 ? ` · ${o.daysOver} day${o.daysOver === 1 ? '' : 's'}` : ''}</Badge>
}

/**
 * The latest movement happened outside the key desk's office hours (P-03, proposed, pending client sign-off). A fact in the trail, not an error:
 * amber, never the danger red, and it says so in words as well as colour.
 */
export function AfterHoursBadge() {
  return <Badge tone="warning" outline>Out of hours</Badge>
}

export const typeLabel = (i: Pick<ItemRow, 'itemTypeLabel' | 'category'>) => i.itemTypeLabel || (i.category === 'key' ? 'Key' : 'Asset')

/** "Due back Fri 30 Oct" or nothing. */
export const dueText = (i: Pick<ItemRow, 'dueBack' | 'status'>) => (i.status === 'issued' && i.dueBack ? `Due back ${fmtDate(i.dueBack)}` : '')

export const EVENT_LABEL: Record<string, string> = {
  issued: 'Issued', returned: 'Returned', lost: 'Reported lost', damaged: 'Reported damaged', retired: 'Retired', replaced: 'Replaced', found: 'Found',
}
