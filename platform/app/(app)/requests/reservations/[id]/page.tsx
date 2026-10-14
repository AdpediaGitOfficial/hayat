import { notFound } from 'next/navigation'
import { requirePage } from '@/server/auth/page'
import { getDb } from '@/server/db/client'
import { isUuid } from '@/server/commands/property/shared'
import { getReservation } from '@/server/queries/requests/reservations'
import { Blocked, GlassCard, PageHeader } from '@/ui'
import { LinkButton, ReservationChip, fmtStamp, range } from '../../_components/format'
import { ReservationActions } from '../../_components/ReservationActions'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Reservation · Grand Hyatt Staff Accommodation' }

export default async function ReservationPage({ params }: { params: { id: string } }) {
  const cur = await requirePage('reservations_stays.view')
  if (!isUuid(params.id)) notFound()
  const r = await getReservation(getDb(), cur.rc.actor, params.id)
  if (!r) notFound()
  const selfBlock = cur.rc.actor.staffId === r.staffId
  return (
    <>
      <PageHeader crumbs={['Requests', 'Reservations', r.name]} title={`Reservation: ${r.name}`}
        summary={<span className="row wrap"><ReservationChip status={r.status} /><span className="muted body-sm">{range(r.from, r.to)}</span></span>}
        actions={<LinkButton href="/requests/reservations">Back</LinkButton>} />
      {r.status === 'reserved' && <Blocked why={`Arrival expected ${r.eta.slice(0, 10)}. If the resident has not arrived by ${fmtStamp(r.noShowDeadline)} the reservation lapses`} owner="Accommodation Admin" next={r.noShowExtended ? 'The deadline was already extended once. Cancel the reservation if the person is not coming' : 'Extend the deadline once with a reason, or cancel the reservation'} />}
      <div className="grid two">
        <GlassCard title="Reservation">
          <dl className="kv">
            <dt>Resident</dt><dd><b>{r.name}</b> <span className="muted mono">{r.employeeId}</span></dd>
            <dt>Bed</dt><dd><span className="mono">{r.bedCode}</span> · Room {r.roomName} · {r.siteName}</dd>
            <dt>Dates</dt><dd className="tnum">{range(r.from, r.to)}</dd>
            <dt>Arrival expected</dt><dd className="tnum">{fmtStamp(r.eta)}</dd>
            <dt>No-show deadline</dt><dd className="tnum">{fmtStamp(r.noShowDeadline)}{r.noShowExtended ? ' (extended once)' : ''}</dd>
            <dt>Source</dt><dd>{r.source}</dd>
            {r.requestId && <><dt>Request</dt><dd><a href={`/requests/${r.requestId}`}>Open the request</a></dd></>}
            {r.cancelReason && <><dt>Cancelled because</dt><dd>{r.cancelReason}</dd></>}
          </dl>
        </GlassCard>
        {(r.can.cancel || r.can.extend) ? <ReservationActions id={r.id} canCancel={r.can.cancel} canExtend={r.can.extend} />
          : selfBlock && r.status === 'reserved' ? <Blocked why="This is your own reservation, so a different Accommodation Admin changes it (separation of duties, D-26)" owner="An independent approver" next="Ask a colleague to cancel or extend it" />
            : <GlassCard title="No actions"><p className="muted body-sm">{r.status === 'reserved' ? 'Your role cannot change reservations.' : 'This reservation is closed.'}</p></GlassCard>}
      </div>
    </>
  )
}
