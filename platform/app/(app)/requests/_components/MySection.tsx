import type { ReactNode } from 'react'
import { getDb } from '@/server/db/client'
import type { CurrentUser } from '@/server/auth/current'
import { alreadyProvided } from '@/server/commands/requests/rules'
import { explainRequest, STAY_TYPE_LABEL } from '@/domain/requests'
import { myAccommodation } from '@/server/queries/requests/mine'
import { Alert, Blocked, GlassCard } from '@/ui'
import { LinkButton, RequestChip, ReservationChip, fmtStamp, range } from './format'
import { CancelMyRequest } from './MyRequestActions'

/**
 * My accommodation, requests and reservations: where the resident's request stands, who has it, what is next, and (once approved)
 * the bed and dates. Blocked and waiting states always say reason, owner and next action (D-93).
 */
export async function renderMyRequests(cur: CurrentUser): Promise<ReactNode | null> {
  const staffId = cur.rc.actor.staffId
  if (!staffId) return null
  const db = getDb()
  const now = cur.rc.clock.now()
  const { request, reservation } = await myAccommodation(db, staffId, now)
  const housedOrQueued = await alreadyProvided(db, staffId, 'You')

  if (!request && !reservation) {
    if (housedOrQueued) return null // a stay, reservation or waitlist entry is shown by its own section
    return (
      <GlassCard title="Request a bed" subtitle="You have no open request.">
        <p className="muted body-sm" style={{ marginBottom: 12 }}>Choose a site and your dates. An Accommodation Admin picks the bed and you are told here and in your notifications.</p>
        <LinkButton href="/requests/new" variant="primary">Request a bed</LinkButton>
      </GlassCard>
    )
  }

  return (
    <>
      {reservation && (
        <div data-testid="my-reservation"><GlassCard title="Your reservation" subtitle="A bed is held for you">
          <dl className="kv">
            <dt>Bed</dt><dd><b>{reservation.bedLabel}</b></dd>
            <dt>Dates</dt><dd className="tnum">{range(reservation.from, reservation.to)}</dd>
            <dt>Status</dt><dd><ReservationChip status={reservation.status} /></dd>
          </dl>
          <div style={{ marginTop: 12 }}>
            <Blocked why="Go to Reception when you arrive to be checked in" owner="Reception" next={`Arrive by ${fmtStamp(reservation.noShowDeadline)}, or ask the Accommodation Admin to move your arrival`} />
          </div>
        </GlassCard></div>
      )}
      {request && (() => {
        const why = explainRequest({ status: request.status, decisionReason: request.decisionReason })
        return (
          <div data-testid="my-request"><GlassCard title="Your request" subtitle={`${request.siteName} · ${STAY_TYPE_LABEL[request.stayType]}`} actions={<RequestChip status={request.status} />}>
            <div className="stack">
              <dl className="kv">
                <dt>Dates</dt><dd className="tnum">{range(request.arrivalDate, request.endDate)}</dd>
                <dt>Filed</dt><dd className="tnum">{fmtStamp(request.createdAt)}</dd>
                {request.note && <><dt>Your note</dt><dd>{request.note}</dd></>}
              </dl>
              {why.tone === 'warning' || why.tone === 'danger'
                ? <Alert tone={why.tone} title={why.title} detail={`Owner: ${why.owner}. Next: ${why.next}.`} />
                : <Blocked why={why.title} owner={why.owner} next={why.next} />}
              <div className="row wrap">
                <LinkButton href={`/requests/${request.id}`} variant={request.canEdit ? 'primary' : 'secondary'}>{request.canEdit ? 'Edit and send back' : 'See details'}</LinkButton>
                {request.canCancel && <CancelMyRequest id={request.id} />}
                {!request.canCancel && ['rejected', 'cancelled'].includes(request.status) && !housedOrQueued && <LinkButton href="/requests/new">New request</LinkButton>}
              </div>
            </div>
          </GlassCard></div>
        )
      })()}
    </>
  )
}
