import Link from 'next/link'
import { requirePage } from '@/server/auth/page'
import { getDb } from '@/server/db/client'
import { RESERVATION_STATUSES, type ReservationStatus } from '@/domain/enums'
import { RESERVATION_CHIP } from '@/domain/requests'
import { isUuid } from '@/server/commands/property/shared'
import { listReservations } from '@/server/queries/requests/reservations'
import { requestableSites } from '@/server/queries/requests/preview'
import { GlassCard, Icon, PageHeader } from '@/ui'
import { LinkButton, ReservationChip, fmtDate, range } from '../_components/format'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Reservations · Grand Hyatt Staff Accommodation' }

type SP = Record<string, string | string[] | undefined>
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? ''
const PAGE = 25

export default async function Reservations({ searchParams }: { searchParams: SP }) {
  const cur = await requirePage('reservations_stays.view')
  const status = one(searchParams.status)
  const siteId = one(searchParams.siteId)
  const q = one(searchParams.q).trim()
  const page = Math.max(1, Number(one(searchParams.page)) || 1)
  const db = getDb()
  const [list, sites] = await Promise.all([
    listReservations(db, cur.rc.actor, {
      status: (RESERVATION_STATUSES as readonly string[]).includes(status) ? (status as ReservationStatus) : undefined,
      siteId: isUuid(siteId) ? siteId : undefined, q, limit: PAGE, offset: (page - 1) * PAGE,
    }),
    requestableSites(db, cur.rc.actor),
  ])
  const pages = Math.max(1, Math.ceil(list.total / PAGE))
  const link = (p: number) => {
    const u = new URLSearchParams()
    if (status) u.set('status', status)
    if (siteId) u.set('siteId', siteId)
    if (q) u.set('q', q)
    if (p > 1) u.set('page', String(p))
    return `/requests/reservations${u.toString() ? '?' + u : ''}`
  }
  return (
    <>
      <PageHeader crumbs={['Requests']} title="Reservations" summary="A reservation holds a bed for dated nights. Check-in turns it into a stay." actions={<LinkButton href="/requests">Requests</LinkButton>} />
      <GlassCard strong flush footer={<>
        <span>{list.total} {list.total === 1 ? 'reservation' : 'reservations'}{list.total > PAGE ? ` · page ${page} of ${pages}` : ''}</span>
        {pages > 1 && <span className="row">
          {page > 1 && <Link href={link(page - 1)} className="btn ghost sm" style={{ textDecoration: 'none' }} rel="prev">Previous</Link>}
          {page < pages && <Link href={link(page + 1)} className="btn ghost sm" style={{ textDecoration: 'none' }} rel="next">Next</Link>}
        </span>}
      </>}>
        <form className="tbl-tool" style={{ paddingTop: 16 }} method="get" role="search" aria-label="Filter reservations">
          <label className="search" style={{ margin: 0, maxWidth: 300 }}>
            <Icon name="search" />
            <input name="q" defaultValue={q} placeholder="Search name or employee ID" aria-label="Search reservations" autoComplete="off" />
          </label>
          <select className="select" name="status" defaultValue={status} aria-label="Status" style={{ maxWidth: 200 }}>
            <option value="">Any status</option>
            {RESERVATION_STATUSES.map(s => <option key={s} value={s}>{RESERVATION_CHIP[s].label}</option>)}
          </select>
          {sites.length > 1 && (
            <select className="select" name="siteId" defaultValue={siteId} aria-label="Site" style={{ maxWidth: 220 }}>
              <option value="">All my sites</option>
              {sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          )}
          <button className="btn secondary" type="submit">Filter</button>
        </form>
        <div className="tbl-wrap">
          <table className="tbl stack-m">
            <thead><tr><th>Resident</th><th>Bed</th><th>Dates</th><th>Status</th><th>Arrival expected</th></tr></thead>
            <tbody>
              {list.items.map(r => (
                <tr key={r.id} data-testid="reservation-row">
                  <td data-h="Resident"><Link href={`/requests/reservations/${r.id}`} style={{ color: 'inherit', textDecoration: 'none' }}><b>{r.name}</b><div className="subtle body-sm mono">{r.employeeId}</div></Link></td>
                  <td data-h="Bed"><span className="mono">{r.bedCode}</span><div className="subtle body-sm">Room {r.roomName} · {r.siteName}</div></td>
                  <td data-h="Dates" className="tnum">{range(r.from, r.to)}</td>
                  <td data-h="Status"><ReservationChip status={r.status} /></td>
                  <td data-h="Arrival expected" className="muted tnum">{fmtDate(r.eta.slice(0, 10))}{r.noShowExtended ? ' · extended once' : ''}</td>
                </tr>
              ))}
              {list.items.length === 0 && <tr><td colSpan={5}><div className="tbl-empty">No reservations match.</div></td></tr>}
            </tbody>
          </table>
        </div>
      </GlassCard>
    </>
  )
}
