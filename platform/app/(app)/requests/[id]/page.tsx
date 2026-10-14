import { notFound } from 'next/navigation'
import { requirePage } from '@/server/auth/page'
import { getDb } from '@/server/db/client'
import { isUuid } from '@/server/commands/property/shared'
import { explainRequest, STAY_TYPE_LABEL } from '@/domain/requests'
import { getRequestDetail } from '@/server/queries/requests/detail'
import { bedsForRequest } from '@/server/queries/requests/beds'
import { requestableSites } from '@/server/queries/requests/preview'
import { Alert, Badge, Blocked, GlassCard, PageHeader } from '@/ui'
import { LinkButton, RequestChip, ReservationChip, UrgentChip, fmtStamp, range } from '../_components/format'
import { RequestActions } from '../_components/RequestActions'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Request · Grand Hyatt Staff Accommodation' }

export default async function RequestPage({ params }: { params: { id: string } }) {
  const cur = await requirePage('requests_waitlist.view')
  if (!isUuid(params.id)) notFound()
  const db = getDb()
  const d = await getRequestDetail(db, cur.rc, params.id, cur.rc.clock.now())
  if (!d) notFound()
  const [beds, sites] = await Promise.all([
    d.can.approve ? bedsForRequest(db, cur.rc.actor, d.id, cur.rc.clock.now()) : Promise.resolve(undefined),
    d.can.edit ? requestableSites(db, cur.rc.actor) : Promise.resolve([]),
  ])
  const staffSide = d.exception !== null
  const why = explainRequest({ status: d.status, decisionReason: d.decisionReason })
  const mine = cur.rc.actor.staffId === d.person.staffId

  return (
    <>
      <PageHeader crumbs={['Requests', d.person.name]} title={mine ? 'My request' : `Request: ${d.person.name}`}
        summary={<span className="row wrap"><RequestChip status={d.status} />{d.urgent && <UrgentChip />}<span className="muted body-sm">{range(d.arrivalDate, d.endDate)} · {d.site.name}</span></span>}
        actions={<LinkButton href={cur.rc.actor.role === 'Res' ? '/my' : '/requests'}>Back</LinkButton>} />

      {d.status === 'approved' && d.reservation
        ? <Alert tone="success" title={why.title} detail={`${d.reservation.bedLabel}. ${why.next}.`} />
        : <Blocked why={why.title} owner={why.owner} next={why.next} />}

      <div className="grid two">
        <div className="stack">
          <GlassCard title="Request">
            <dl className="kv">
              <dt>Person</dt><dd><b>{d.person.name}</b> <span className="muted mono">{d.person.employeeId}</span>{d.person.department && <span className="muted"> · {d.person.department}</span>}</dd>
              {d.profileVisible && <><dt>Gender, grade</dt><dd>{d.person.gender ? (d.person.gender === 'male' ? 'Male' : 'Female') : <span className="muted">not recorded</span>}, {d.person.grade ?? <span className="muted">no grade</span>}</dd></>}
              <dt>Site</dt><dd>{d.site.name}</dd>
              <dt>Arrival</dt><dd className="tnum">{d.arrivalDate}</dd>
              <dt>Departure day</dt><dd className="tnum">{d.endDate ?? 'Open-ended (permanent)'}</dd>
              <dt>Stay type</dt><dd>{STAY_TYPE_LABEL[d.stayType]}</dd>
              <dt>Note</dt><dd>{d.note ?? <span className="muted">none</span>}</dd>
              <dt>Filed</dt><dd className="tnum">{fmtStamp(d.createdAt)}{d.onBehalf && d.submittedBy ? ` · on behalf, by ${d.submittedBy}` : ''}</dd>
              {d.clock && <><dt>Approval clock</dt><dd data-testid="sla">{d.clock.label} · {d.clock.businessDays} business day{d.clock.businessDays === 1 ? '' : 's'} · {d.clock.reminders} reminder{d.clock.reminders === 1 ? '' : 's'}</dd></>}
            </dl>
          </GlassCard>

          {d.reservation && (
            <GlassCard title="Reservation" subtitle="Approving reserved this bed. Reception checks the resident in on arrival.">
              <dl className="kv">
                <dt>Bed</dt><dd>{d.reservation.bedLabel}</dd>
                <dt>Dates</dt><dd className="tnum">{range(d.reservation.from, d.reservation.to)}</dd>
                <dt>Status</dt><dd><ReservationChip status={d.reservation.status} /></dd>
              </dl>
              {staffSide && <div style={{ marginTop: 12 }}><LinkButton href={`/requests/reservations/${d.reservation.id}`} size="sm">Open reservation</LinkButton></div>}
            </GlassCard>
          )}

          {d.exception && (d.exception.asks.length > 0 || d.exception.granted.length > 0) && (
            <GlassCard title="Policy Approver exceptions" subtitle="Gender and grade exceptions are scoped to this request. Every use is reported.">
              <ul className="list-plain">
                {d.exception.asks.map(a => (
                  <li key={a.id} style={{ display: 'block' }}>
                    <div className="row wrap"><Badge tone={a.status === 'granted' ? 'success' : a.status === 'declined' ? 'danger' : a.status === 'asked' ? 'brand' : 'neutral'}>{a.status === 'asked' ? 'Waiting' : a.status}</Badge><b>{a.kinds.join(' and ')}</b><span className="muted body-sm tnum">{fmtStamp(a.askedAt)}</span></div>
                    <div className="body-sm">{a.reason}</div>
                    {a.decisionReason && <div className="muted body-sm">Decision: {a.decisionReason}</div>}
                  </li>
                ))}
                {d.exception.granted.map(g => (
                  <li key={g.id} style={{ display: 'block' }}>
                    <div className="row wrap"><Badge tone="success">Granted</Badge><b>{g.kind}</b><span className="muted body-sm">used {g.uses} time{g.uses === 1 ? '' : 's'}</span></div>
                    <div className="body-sm">{g.reason}</div>
                    <div className="muted body-sm">Evidence: {g.evidence}</div>
                  </li>
                ))}
              </ul>
            </GlassCard>
          )}

          <GlassCard title="What happened" subtitle="From the audit log">
            <ul className="list-plain" data-testid="timeline">
              {d.timeline.map((t, i) => (
                <li key={i} style={{ display: 'block' }}>
                  <div className="row wrap"><b>{t.label}</b><span className="muted body-sm tnum">{fmtStamp(t.at)}</span>{t.actor && <span className="muted body-sm">· {t.actor}</span>}</div>
                  {t.reason && <div className="body-sm muted">{t.reason}</div>}
                </li>
              ))}
              {d.timeline.length === 0 && <li className="muted">Nothing recorded yet.</li>}
            </ul>
          </GlassCard>
        </div>

        <RequestActions request={d} beds={beds} sites={sites.map(s => ({ id: s.id, name: s.name }))} />
      </div>
    </>
  )
}
