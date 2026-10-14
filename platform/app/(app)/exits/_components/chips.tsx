import { Badge, type Tone } from '@/ui'
import type { ClearanceItemStatus, ClearanceStatus } from '@/server/db/schema.exit'
import { CASE_STATUS_LABEL, STATUS_LABEL } from '@/server/commands/exit/rules'

const CASE_TONE: Record<ClearanceStatus, Tone> = { open: 'warning', in_progress: 'info', pending_items: 'danger', cleared: 'success' }
const ITEM_TONE: Record<ClearanceItemStatus, Tone> = { open: 'warning', done: 'success', waived: 'info', outstanding: 'danger' }

/** The status chip of a clearance case (the main visual language). Danger = something is stuck, distinct from the brand red. */
export function CaseChip({ status }: { status: ClearanceStatus }) {
  return <Badge tone={CASE_TONE[status]}>{CASE_STATUS_LABEL[status]}</Badge>
}
export function ItemChip({ status }: { status: ClearanceItemStatus }) {
  return <Badge tone={ITEM_TONE[status]}>{STATUS_LABEL[status]}</Badge>
}
export function DueChip({ dueDate, overdue, daysOverdue }: { dueDate: string; overdue: boolean; daysOverdue: number }) {
  return overdue
    ? <Badge tone="danger">Overdue {daysOverdue} day{daysOverdue === 1 ? '' : 's'} · due {dueDate}</Badge>
    : <Badge tone="neutral" outline>Due {dueDate}</Badge>
}
