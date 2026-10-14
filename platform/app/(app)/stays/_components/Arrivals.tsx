'use client'
/**
 * Reception's arrivals: pick the reservation, see whether the bed is ready, check in. Phone-first: one card per arrival, big
 * buttons, the reason a check-in is blocked is shown with its owner and next action instead of a disabled button without
 * explanation. Bulk check-in sends the ticked rows; the answer is per row and a retry is safe (D-60).
 */
import { useState } from 'react'
import { Alert, Badge, Blocked, Button, GlassCard, Status } from '@/ui'
import { fmtDate } from '@/domain/time'
import type { ArrivalRow } from '@/server/queries/stays/arrivals'
import type { BulkCheckInOut } from '@/server/commands/stays/checkIn'
import { Problem, useCall } from './call'

const TONE: Record<ArrivalRow['view'], string> = { Expected: 'Expected', 'Not ready': 'Not ready', 'No-show': 'No-show' }

export function Arrivals({ due, later, canCheckIn, selfStaffId }: { due: ArrivalRow[]; later: ArrivalRow[]; canCheckIn: boolean; selfStaffId?: string }) {
  const { run, busy, err } = useCall()
  const [picked, setPicked] = useState<string[]>([])
  const [result, setResult] = useState<BulkCheckInOut>()
  const ready = due.filter(r => !r.block && r.staffId !== selfStaffId)
  // Reception often covers several sites: the bed path already starts with the site name, so only the grouping order matters here.

  async function one(r: ArrivalRow) {
    await run('/api/v1/stays/check-in', { reservationId: r.reservationId })
  }
  async function bulk() {
    await run<BulkCheckInOut>('/api/v1/stays/check-in/bulk', { reservationIds: picked }, r => { setResult(r.data); setPicked([]) })
  }

  return (
    <div className="stack">
      <GlassCard title="Arriving today" subtitle="Reservations whose arrival day has come. A bed that is not ready cannot be checked into; the card says why and who can fix it."
        actions={canCheckIn && ready.length > 0 ? <Button variant="primary" disabled={busy || picked.length === 0} onClick={bulk}>{`Check in selected (${picked.length})`}</Button> : undefined}>
        {err && <div style={{ marginBottom: 12 }}><Problem f={err} /></div>}
        {result && <BulkResult result={result} due={due} />}
        {due.length === 0 ? <div className="tbl-empty">No arrivals waiting. Reservations appear here on their arrival day.</div> : (
          <ul className="list-plain" aria-label="Arrivals due">
            {due.map(r => (
              <li key={r.reservationId} style={{ display: 'block' }} data-arrival={r.employeeId || r.reservationId}>
                <div className="row wrap" style={{ alignItems: 'flex-start', gap: 12 }}>
                  {canCheckIn && !r.block && r.staffId !== selfStaffId && (
                    <span style={{ paddingTop: 2 }}>
                      <input type="checkbox" aria-label={`Select ${r.name}`} checked={picked.includes(r.reservationId)} onChange={e => setPicked(e.target.checked ? [...picked, r.reservationId] : picked.filter(x => x !== r.reservationId))} />
                    </span>
                  )}
                  <div style={{ flex: 1, minWidth: 220 }}>
                    <div className="row wrap" style={{ gap: 8 }}>
                      <b>{r.name}</b>{r.employeeId && <span className="mono muted">{r.employeeId}</span>}
                      <Status s={TONE[r.view]} />
                    </div>
                    <div className="body-sm">{r.bedLabel}</div>
                    <div className="muted body-sm">Arrives {fmtDate(r.from)}{r.to ? ` · leaves ${fmtDate(r.to)}` : ' · open-ended'}{r.noShowExtended ? ' · no-show window extended' : ''}</div>
                  </div>
                  {canCheckIn && (
                    <Button variant="primary" tall disabled={busy || !!r.block || r.staffId === selfStaffId} aria-label={`Check in ${r.name}`} onClick={() => one(r)}>Check in</Button>
                  )}
                </div>
                {r.staffId === selfStaffId && <div style={{ marginTop: 8 }}><Blocked why="You cannot check yourself in" owner="Another Reception officer or an Accommodation Admin" next="Ask a colleague to process your arrival (separation of duties)" /></div>}
                {r.block && <div style={{ marginTop: 8 }}><Blocked why={r.block.reason} owner={r.block.owner} next={r.block.next} /></div>}
                {r.view === 'No-show' && <div style={{ marginTop: 8 }}><Alert tone="warning" title="No-show window passed" detail={`The hold is released automatically after ${new Date(r.noShowAfter).toISOString().slice(0, 16).replace('T', ' ')} UTC. The person can still be checked in until then.`} /></div>}
              </li>
            ))}
          </ul>
        )}
      </GlassCard>

      {later.length > 0 && (
        <GlassCard title="Expected in the next days" subtitle="A bed still being cleaned for a later arrival is fine: readiness is checked at check-in, not at reservation.">
          <ul className="list-plain" aria-label="Expected arrivals">
            {later.map(r => (
              <li key={r.reservationId} style={{ flexWrap: 'wrap' }}>
                <span style={{ flex: 1, minWidth: 200 }}><b>{r.name}</b> {r.employeeId && <span className="mono muted">{r.employeeId}</span>}<span className="muted body-sm" style={{ display: 'block' }}>{r.bedLabel}</span></span>
                <Badge tone="info">Arrives {fmtDate(r.from)}</Badge>
                {r.bedState !== 'available' && <Badge tone="warning">Bed {r.bedState.replace(/_/g, ' ')}</Badge>}
              </li>
            ))}
          </ul>
        </GlassCard>
      )}
    </div>
  )
}

function BulkResult({ result, due }: { result: BulkCheckInOut; due: ArrivalRow[] }) {
  const name = (id: string) => due.find(r => r.reservationId === id)?.name ?? 'Arrival'
  return (
    <div style={{ marginBottom: 12 }}>
      <Alert tone={result.failed ? 'warning' : 'success'} title={`${result.checkedIn} checked in${result.alreadyDone ? `, ${result.alreadyDone} already done` : ''}${result.failed ? `, ${result.failed} need attention` : ''}`} />
      <ul className="list-plain" aria-label="Bulk check-in result">
        {result.rows.map(r => (
          <li key={r.reservationId} style={{ display: 'block' }}>
            <b>{name(r.reservationId)}</b>{' '}
            {r.outcome === 'failed' ? <><Badge tone="danger">Not checked in</Badge><Blocked why={r.reason} owner={r.owner} next={r.next} /></> : <Badge tone="success">{r.outcome === 'checked_in' ? 'Checked in' : 'Already checked in'}</Badge>}
          </li>
        ))}
      </ul>
    </div>
  )
}
