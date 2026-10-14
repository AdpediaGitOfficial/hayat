import Link from 'next/link'
import type { ReactNode } from 'react'
import type { CurrentUser } from '@/server/auth/current'
import { myKeys } from '@/server/queries/keys/items'
import { getDb } from '@/server/db/client'
import { getConfig } from '@/server/config/registry'
import { Blocked, GlassCard } from '@/ui'
import { fmtDate, fmtDateLong } from '@/domain/time'
import { OverdueBadge, StatusChip } from './bits'
import { ReportLostButton } from './ReportLost'

/**
 * "My keys and assets" on /my: what the resident holds and when it is due back. A resident sees only their own items (keys.view own).
 * A lost or damaged item is shown as still theirs to resolve, never as returned. They hand items back at Reception; they cannot
 * record anything themselves.
 *
 * "Report lost" (P-05, PROPOSED, pending client sign-off) is offered only when `keys.resident_may_report_lost` is on, and only for an item
 * that is issued. It can only say "lost": the resident can never mark anything returned or found.
 */
export async function renderMyKeys(cur: CurrentUser): Promise<ReactNode | null> {
  const { actor } = cur.rc
  if (!actor.staffId) return null
  const items = await myKeys(actor, cur.rc.clock.now())
  if (items.length === 0) return null
  const mayReport = await getConfig(getDb(), 'keys.resident_may_report_lost')
  const trouble = items.filter(i => i.status === 'lost' || i.status === 'damaged')
  return (
    <GlassCard title="My keys and assets" subtitle="Hand them back at Reception when you leave, or by the date shown.">
      <div className="stack" style={{ gap: 12 }}>
        {trouble.length > 0 && <Blocked why={`${trouble.length} item${trouble.length === 1 ? ' is' : 's are'} recorded as lost or damaged and still on your record`} owner="Accommodation Admin" next="They will contact you to replace or settle it. You cannot leave it unresolved" />}
        <ul className="list-plain" aria-label="Keys and assets I hold">
          {items.map(i => (
            <li key={i.id} style={{ flexWrap: 'wrap', alignItems: 'flex-start' }}>
              <span style={{ flex: 1, minWidth: 180 }}>
                <Link href={`/keys/${i.id}`}><b>{i.itemTypeLabel} {i.code}</b></Link>
                {i.forLabel && <span className="muted body-sm" style={{ display: 'block' }}>{i.forLabel}</span>}
                <span className="muted body-sm" style={{ display: 'block' }}>
                  {i.status === 'issued' ? (i.dueBack ? `Return by ${fmtDateLong(i.dueBack)}` : 'Return it when you check out') : i.status === 'lost' ? 'Reported lost' : 'Reported damaged'}
                  {i.issuedAt ? ` · issued ${fmtDate(i.issuedAt.slice(0, 10))}` : ''}
                </span>
              </span>
              <span className="row wrap" style={{ gap: 6 }}>
                <StatusChip status={i.status} /><OverdueBadge o={i.overdue} />
                {mayReport && i.status === 'issued' && <ReportLostButton item={{ id: i.id, code: i.code, label: `${i.itemTypeLabel} ${i.code}`, status: i.status }} />}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </GlassCard>
  )
}
