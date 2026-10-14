import Link from 'next/link'
import { requirePage } from '@/server/auth/page'
import { can } from '@/server/policy'
import { listArrivals } from '@/server/queries/stays/arrivals'
import { listStays } from '@/server/queries/stays/stays'
import { listPendingRequests } from '@/server/queries/stays/transfers'
import { Badge, GlassCard, Icon, PageHeader, Person, Status } from '@/ui'
import { fmtDate } from '@/domain/time'
import { Arrivals } from './_components/Arrivals'
import { FlagBadge } from './_components/FlagBadge'
import { CheckoutRow, ExtensionDecision } from './_components/StayActions'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Stays & check-in · Grand Hyatt Staff Accommodation' }

type SP = Record<string, string | string[] | undefined>
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? ''
const FILTERS = [
  { id: '', label: 'All active' },
  { id: 'attention', label: 'Needs attention' },
  { id: 'ending', label: 'Ending soon' },
  { id: 'overdue', label: 'Overdue' },
] as const

export default async function Stays({ searchParams }: { searchParams: SP }) {
  const cur = await requirePage('checkin_checkout.view')
  const { actor } = cur.rc
  const flagParam = one(searchParams.flag)
  const flag = flagParam === 'overdue' || flagParam === 'ending' || flagParam === 'attention' ? flagParam : undefined
  const [arrivals, stays, pending] = await Promise.all([listArrivals(actor), listStays(actor, { flag, limit: 100 }), listPendingRequests(actor)])
  const canCheckIn = can(actor, 'checkin_checkout.execute')
  const due = arrivals.filter(a => a.due)
  const later = arrivals.filter(a => !a.due)
  const waiting = pending.extensions.length + pending.checkouts.length

  return (
    <>
      <PageHeader
        crumbs={['Accommodation']} title="Stays & check-in"
        summary="Check residents in, see who is ending or overdue, and handle extensions, moves and departures. Nobody is ever checked out or moved automatically."
        actions={can(actor, 'transfers_swaps.view') ? <Link href="/stays/transfers" className="btn secondary" style={{ textDecoration: 'none' }}><Icon name="swap" />Transfers &amp; swaps</Link> : undefined}
      />
      <div className="stack">
        <Arrivals due={due} later={later} canCheckIn={canCheckIn} selfStaffId={actor.staffId} />

        {waiting > 0 && (
          <GlassCard title="Waiting for someone" subtitle="Requests on stays that have not been decided or carried out yet">
            <ul className="list-plain" aria-label="Requests waiting">
              {pending.extensions.map(e => (
                <li key={e.id} style={{ display: 'block' }}>
                  <div className="row wrap" style={{ gap: 8 }}>
                    <b>Extension</b><Link href={`/stays/${e.stayId}`}>{e.name}</Link>
                    <span className="muted body-sm">until {fmtDate(e.newEnd)} (+{e.addedDays} days)</span>
                    {e.beyondPolicy ? <Badge tone="warning">Beyond policy: Policy Approver</Badge> : <Badge tone="info">Accommodation Admin</Badge>}
                    {e.clash && <Badge tone="danger">Bed booked next</Badge>}
                  </div>
                  {e.reason && <div className="muted body-sm">{e.reason}</div>}
                  <div style={{ marginTop: 8 }}>
                    <ExtensionDecision id={e.id} canDecide={e.canDecide} why={e.canDecide ? undefined : 'You cannot decide this one: it is not yours to decide, or it is about you or was raised by you (separation of duties).'} />
                  </div>
                </li>
              ))}
              {pending.checkouts.map(c => (
                <li key={c.id} style={{ display: 'block' }}>
                  <div className="row wrap" style={{ gap: 8 }}>
                    <b>Checkout</b><Link href={`/stays/${c.stayId}`}>{c.name}</Link>
                    <span className="muted body-sm">leaving {fmtDate(c.departureDate)}</span>
                    <Status s={c.status === 'acknowledged' ? 'Accepted' : 'Pending'} label={c.status === 'acknowledged' ? 'Acknowledged' : 'Needs acknowledgement'} />
                  </div>
                  <div style={{ marginTop: 8 }}><CheckoutRow id={c.id} stayId={c.stayId} canProcess={c.canProcess} status={c.status} /></div>
                </li>
              ))}
            </ul>
          </GlassCard>
        )}

        <GlassCard strong flush title="Current stays" subtitle="Overdue and ending stays first. An overdue stay stays active until Reception checks the resident out."
          footer={<span>{stays.total} {stays.total === 1 ? 'stay' : 'stays'}{stays.total > stays.rows.length ? `, showing ${stays.rows.length}` : ''}</span>}>
          <div className="tbl-tool" style={{ paddingTop: 16 }} role="tablist" aria-label="Filter stays">
            {FILTERS.map(f => (
              <Link key={f.id} href={f.id ? `/stays?flag=${f.id}` : '/stays'} className={`btn ${flag === (f.id || undefined) ? 'primary' : 'secondary'} sm`} style={{ textDecoration: 'none' }} aria-current={flag === (f.id || undefined) ? 'true' : undefined}>{f.label}</Link>
            ))}
          </div>
          <div className="tbl-wrap">
            <table className="tbl stack-m">
              <thead><tr><th>Resident</th><th>Bed</th><th>Stay</th><th>Flag</th></tr></thead>
              <tbody>
                {stays.rows.map(s => (
                  <tr key={s.id}>
                    <td data-h="Resident"><Link href={`/stays/${s.id}`} style={{ textDecoration: 'none', color: 'inherit' }}><Person name={s.name} sub={s.employeeId || undefined} /></Link></td>
                    <td data-h="Bed">{s.bedLabel}</td>
                    <td data-h="Stay">{fmtDate(s.from)} to {s.to ? fmtDate(s.to) : 'open-ended'}</td>
                    <td data-h="Flag"><FlagBadge s={s} /></td>
                  </tr>
                ))}
                {stays.rows.length === 0 && <tr><td colSpan={4}><div className="tbl-empty">{flag ? 'Nothing matches this filter.' : 'No active stays in your sites yet.'}</div></td></tr>}
              </tbody>
            </table>
          </div>
        </GlassCard>
      </div>
    </>
  )
}
