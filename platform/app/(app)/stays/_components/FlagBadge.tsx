import { Badge } from '@/ui'
import type { StayRow } from '@/server/queries/stays/stays'

/** The ending / overdue chip. Overdue and escalated use the danger tone, distinct from the brand red (CLAUDE.md design direction). */
export function FlagBadge({ s }: { s: Pick<StayRow, 'flag' | 'daysLeft' | 'daysOver'> }) {
  if (s.flag === 'escalated') return <Badge tone="danger">Overdue {s.daysOver} days · escalated</Badge>
  if (s.flag === 'overdue') return <Badge tone="danger">Overdue {s.daysOver} day{s.daysOver === 1 ? '' : 's'}</Badge>
  if (s.flag === 'ending') return <Badge tone="warning">{s.daysLeft === 0 ? 'Ends today' : `Ends in ${s.daysLeft} day${s.daysLeft === 1 ? '' : 's'}`}</Badge>
  return null
}
