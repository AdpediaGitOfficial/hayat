import Link from 'next/link'
import type { ReactNode } from 'react'
import { requirePage } from '@/server/auth/page'
import { keysForStay, type ItemRow } from '@/server/queries/keys/items'
import { Blocked, GlassCard } from '@/ui'
import { fmtDate } from '@/domain/time'
import { OverdueBadge, StatusChip } from './bits'
import { PanelIssue, PanelReturn } from './PanelActions'

/**
 * Keys and assets of ONE stay, for the stay page (self-contained: it reads who is looking and what they may see itself).
 *  - what the person holds for this bed or room, with Record return for those who hand items out,
 *  - what is left over from a bed or room they moved out of: to return and reissue after a transfer (D-61),
 *  - what is in the cabinet for this bed or room, to issue now.
 * Renders nothing when the viewer has no keys access at the stay's site. A lost or damaged item is shown as outstanding, never as returned.
 *
 *   <KeysPanel stayId={d.id} />
 */
export async function KeysPanel({ stayId }: { stayId: string }): Promise<JSX.Element | null> {
  const cur = await requirePage()
  const now = cur.rc.clock.now()
  const k = await keysForStay(cur.rc.actor, stayId, now)
  if (!k) return null
  const today = now.toISOString().slice(0, 10)
  const canMove = k.abilities.move && cur.rc.actor.staffId !== k.staffId
  const held = k.here.length + k.toSwap.length + k.unlinked.length

  const row = (r: ItemRow, actions: ReactNode) => (
    <li key={r.id} style={{ flexWrap: 'wrap', alignItems: 'flex-start' }}>
      <span style={{ flex: 1, minWidth: 180 }}>
        <Link href={`/keys/${r.id}`}><b>{r.code}</b></Link> <span className="muted body-sm">{r.itemTypeLabel}{r.forLabel ? ` · ${r.forLabel}` : ''}</span>
        <span className="row wrap" style={{ gap: 6, marginTop: 4 }}><StatusChip status={r.status} /><OverdueBadge o={r.overdue} />{r.status === 'issued' && r.dueBack && <span className="muted body-sm">due back {fmtDate(r.dueBack)}</span>}</span>
      </span>
      {actions}
    </li>
  )
  const ref = (r: ItemRow) => ({ id: r.id, code: r.code, label: `${r.itemTypeLabel} ${r.code}`, status: r.status })
  const give = (r: ItemRow) => r.status === 'issued' && canMove && r.holder
    ? <PanelReturn item={ref(r)} holder={r.holder.name} holderLeft={r.holder.left} />
    : r.status === 'lost' || r.status === 'damaged' ? <span className="muted body-sm">Not returned: <Link href={`/keys/${r.id}`}>find, replace or retire</Link></span> : null

  return (
    <GlassCard title="Keys & assets" subtitle={`Bed ${k.bedCode}, ${k.roomName}`} actions={<Link href={`/keys?q=${encodeURIComponent(k.bedCode)}`} className="btn ghost sm" style={{ textDecoration: 'none' }}>Open keys</Link>}>
      <div className="stack" style={{ gap: 14 }}>
        {k.toSwap.length > 0 && (
          <div className="stack" style={{ gap: 8 }} data-testid="keys-to-swap">
            <Blocked why={`${k.toSwap.length} key${k.toSwap.length === 1 ? '' : 's'} from the bed or room they moved out of ${k.toSwap.length === 1 ? 'is' : 'are'} still with them`} owner="Reception" next="Take them back, then issue the keys for the new bed below" />
            <ul className="list-plain" aria-label="Keys to return after the move">{k.toSwap.map(r => row(r, give(r)))}</ul>
          </div>
        )}
        <div className="stack" style={{ gap: 6 }}>
          <b className="body-sm">Held for this bed or room</b>
          {k.here.length === 0 ? <p className="muted body-sm">Nothing issued for this bed yet.</p> : <ul className="list-plain" aria-label="Keys held">{k.here.map(r => row(r, give(r)))}</ul>}
        </div>
        {k.unlinked.length > 0 && (
          <div className="stack" style={{ gap: 6 }}>
            <b className="body-sm">Other assets held</b>
            <ul className="list-plain" aria-label="Other assets held">{k.unlinked.map(r => row(r, give(r)))}</ul>
          </div>
        )}
        {canMove && (
          <div className="stack" style={{ gap: 6 }}>
            <b className="body-sm">In the cabinet for this bed or room</b>
            {k.available.length === 0
              ? <p className="muted body-sm">{held === 0 ? 'No key for this bed or room is in the cabinet. Ask the Accommodation Admin to add one.' : 'No further key for this bed or room is in the cabinet.'}</p>
              : <ul className="list-plain" aria-label="Keys in the cabinet">{k.available.map(r => row(r, <PanelIssue item={ref(r)} staff={{ id: k.staffId, name: k.staffName }} today={today} />))}</ul>}
          </div>
        )}
      </div>
    </GlassCard>
  )
}
