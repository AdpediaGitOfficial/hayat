import Link from 'next/link'
import { redirect } from 'next/navigation'
import { requirePage } from '@/server/auth/page'
import { getDb } from '@/server/db/client'
import { can } from '@/server/policy'
import { REQUEST_STATUSES, type RequestStatus } from '@/domain/enums'
import { REQUEST_CHIP, STAY_TYPE_LABEL } from '@/domain/requests'
import { isUuid } from '@/server/commands/property/shared'
import { listRequests } from '@/server/queries/requests/list'
import { requestableSites } from '@/server/queries/requests/preview'
import { GlassCard, Icon, PageHeader } from '@/ui'
import { LinkButton, RequestChip, range, UrgentChip, fmtStamp } from './_components/format'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Requests · Grand Hyatt Staff Accommodation' }

type SP = Record<string, string | string[] | undefined>
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? ''
const PAGE = 25

export default async function Requests({ searchParams }: { searchParams: SP }) {
  const cur = await requirePage('requests_waitlist.view')
  const { actor } = cur.rc
  if (actor.role === 'Res') redirect('/my') // a Resident's requests live on My accommodation
  const status = one(searchParams.status)
  const siteId = one(searchParams.siteId)
  const q = one(searchParams.q).trim()
  const page = Math.max(1, Number(one(searchParams.page)) || 1)
  const filterStatus = (status === 'open' || (REQUEST_STATUSES as readonly string[]).includes(status) ? status : 'open') as RequestStatus | 'open'

  const db = getDb()
  const [list, sites] = await Promise.all([
    listRequests(db, actor, { status: status === 'all' ? undefined : filterStatus, siteId: isUuid(siteId) ? siteId : undefined, q, limit: PAGE, offset: (page - 1) * PAGE }, cur.rc.clock.now()),
    requestableSites(db, actor),
  ])
  const pages = Math.max(1, Math.ceil(list.total / PAGE))
  const link = (p: number) => {
    const u = new URLSearchParams()
    if (status) u.set('status', status)
    if (siteId) u.set('siteId', siteId)
    if (q) u.set('q', q)
    if (p > 1) u.set('page', String(p))
    return `/requests${u.toString() ? '?' + u : ''}`
  }

  return (
    <>
      <PageHeader eyebrow="Accommodation" title="Requests" summary="A request is not a reservation: approving one picks the bed and reserves it in one step."
        actions={<>
          {can(actor, 'checkin_checkout.allocate_bulk') && <LinkButton href="/requests/bulk">Bulk allocation</LinkButton>}
          <LinkButton href="/requests/reservations">Reservations</LinkButton>
          {can(actor, 'requests_waitlist.submit') && <LinkButton href="/requests/new" variant="primary">New request</LinkButton>}
        </>} />

      <GlassCard strong flush footer={<>
        <span>{list.total} {list.total === 1 ? 'request' : 'requests'}{list.total > PAGE ? ` · page ${page} of ${pages}` : ''}</span>
        {pages > 1 && <span className="row">
          {page > 1 && <Link href={link(page - 1)} className="btn ghost sm" style={{ textDecoration: 'none' }} rel="prev">Previous</Link>}
          {page < pages && <Link href={link(page + 1)} className="btn ghost sm" style={{ textDecoration: 'none' }} rel="next">Next</Link>}
        </span>}
      </>}>
        <form className="tbl-tool" style={{ paddingTop: 16 }} method="get" role="search" aria-label="Filter requests">
          <label className="search" style={{ margin: 0, maxWidth: 300 }}>
            <Icon name="search" />
            <input name="q" defaultValue={q} placeholder="Search name or employee ID" aria-label="Search requests" autoComplete="off" />
          </label>
          <select className="select" name="status" defaultValue={status || 'open'} aria-label="Status" style={{ maxWidth: 220 }}>
            <option value="open">Open (needs a decision)</option>
            <option value="all">Any status</option>
            {REQUEST_STATUSES.filter(s => s !== 'draft').map(s => <option key={s} value={s}>{REQUEST_CHIP[s].label}</option>)}
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
            <thead><tr><th>Person</th><th>Site</th><th>Dates</th><th>Type</th><th>Status</th><th>Filed</th></tr></thead>
            <tbody>
              {list.items.map(r => (
                <tr key={r.id} data-testid="request-row">
                  <td data-h="Person"><Link href={`/requests/${r.id}`} style={{ color: 'inherit', textDecoration: 'none' }}><b>{r.name}</b><div className="subtle body-sm mono">{r.employeeId}</div></Link></td>
                  <td data-h="Site">{r.siteName}</td>
                  <td data-h="Dates" className="tnum">{range(r.arrivalDate, r.endDate)}</td>
                  <td data-h="Type">{STAY_TYPE_LABEL[r.stayType]}</td>
                  <td data-h="Status"><span className="row wrap" style={{ gap: 6 }}><RequestChip status={r.status} />{r.urgent && <UrgentChip />}</span></td>
                  <td data-h="Filed" className="muted tnum">{fmtStamp(r.createdAt)}{r.onBehalf ? ' · on behalf' : ''}</td>
                </tr>
              ))}
              {list.items.length === 0 && <tr><td colSpan={6}><div className="tbl-empty">Nothing matches. Try another status or clear the search.</div></td></tr>}
            </tbody>
          </table>
        </div>
      </GlassCard>
    </>
  )
}
