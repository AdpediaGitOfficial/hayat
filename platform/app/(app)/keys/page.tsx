import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requirePage } from '@/server/auth/page'
import { canMoveKeys, canUseKeys, listItems, type ItemFilters } from '@/server/queries/keys/items'
import { decide } from '@/server/policy'
import { Badge, Blocked, GlassCard, Icon, PageHeader, Person } from '@/ui'
import { fmtDate } from '@/domain/time'
import { Desk } from './_components/Desk'
import { OverdueBadge, StatusChip } from './_components/bits'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Keys & assets · Grand Hyatt Staff Accommodation' }

type SP = Record<string, string | string[] | undefined>
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? ''
const FILTERS = [
  { id: '', label: 'Out now', status: 'outstanding' as const },
  { id: 'overdue', label: 'Overdue' },
  { id: 'cabinet', label: 'In the cabinet', status: 'in_cabinet' as const },
  { id: 'lost', label: 'Lost', status: 'lost' as const },
  { id: 'damaged', label: 'Damaged', status: 'damaged' as const },
  { id: 'retired', label: 'Retired', status: 'retired' as const },
  { id: 'all', label: 'All' },
] as const

export default async function Keys({ searchParams }: { searchParams: SP }) {
  const cur = await requirePage()
  const { actor } = cur.rc
  if (!canUseKeys(actor)) notFound()
  const filter = FILTERS.find(f => f.id === one(searchParams.show)) ?? FILTERS[0]
  const q = one(searchParams.q).trim()
  const f: ItemFilters = {
    q: q || undefined, limit: 200,
    status: 'status' in filter ? filter.status : undefined,
    overdue: filter.id === 'overdue' ? true : undefined,
  }
  const [{ rows, total }, overdue] = await Promise.all([listItems(actor, f), listItems(actor, { overdue: true, limit: 1 })])
  const canMove = canMoveKeys(actor)
  const canManage = decide(actor, 'keys.manage').allowed
  const resident = !canMove && !canManage && decide(actor, 'keys.view').allowed && actor.role === 'Res'
  const today = cur.rc.clock.now().toISOString().slice(0, 10)
  const href = (show: string, query = q) => `/keys?${new URLSearchParams({ ...(show ? { show } : {}), ...(query ? { q: query } : {}) }).toString()}`

  return (
    <>
      <PageHeader
        crumbs={['Accommodation']} title="Keys & assets"
        summary={resident ? 'The keys and assets you hold.' : 'Who holds which key or asset. Overdue is worked out from the due date, the end of the stay and who has left; nothing is marked returned automatically.'}
        actions={canManage ? <Link href="/keys/new" className="btn secondary" style={{ textDecoration: 'none' }}><Icon name="plus" />Add keys</Link> : undefined}
      />
      <div className="stack">
        {canMove && <Desk today={today} />}
        {overdue.total > 0 && filter.id !== 'overdue' && (
          <Blocked why={`${overdue.total} key${overdue.total === 1 ? '' : 's'} or asset${overdue.total === 1 ? ' is' : 's are'} overdue`} owner="Reception" next="Arrange the return, or record the item as lost or damaged. Nothing is returned for you" />
        )}
        <GlassCard strong flush title={filter.label} subtitle="Overdue first, then lost and damaged, then what is issued."
          footer={<span>{total} {total === 1 ? 'item' : 'items'}{total > rows.length ? `, showing ${rows.length}` : ''}</span>}>
          <div className="tbl-tool" style={{ paddingTop: 16 }} role="tablist" aria-label="Filter keys and assets">
            {FILTERS.map(x => (
              <Link key={x.id} href={href(x.id)} className={`btn ${x.id === filter.id ? 'primary' : 'secondary'} sm`} style={{ textDecoration: 'none' }} aria-current={x.id === filter.id ? 'true' : undefined}>
                {x.label}{x.id === 'overdue' && overdue.total > 0 ? ` (${overdue.total})` : ''}
              </Link>
            ))}
          </div>
          {!resident && (
            <form className="tbl-tool" action="/keys" method="get" role="search" aria-label="Search keys and assets">
              {filter.id && <input type="hidden" name="show" value={filter.id} />}
              <input className="input" name="q" defaultValue={q} placeholder="Search by code or person" aria-label="Search by code or person" style={{ flex: 1, minWidth: 180 }} />
              <button className="btn secondary sm" type="submit"><Icon name="search" />Search</button>
            </form>
          )}
          <div className="tbl-wrap">
            <table className="tbl stack-m">
              <thead><tr><th>Item</th><th>For</th><th>Status</th>{!resident && <th>Held by</th>}<th>Due</th></tr></thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.id}>
                    <td data-h="Item"><Link href={`/keys/${r.id}`} style={{ textDecoration: 'none', color: 'inherit' }}><b>{r.code}</b> <span className="muted body-sm">{r.itemTypeLabel}</span></Link></td>
                    <td data-h="For">{r.forLabel ?? <span className="muted">Not tied to a bed or room</span>}<div className="muted body-sm">{r.siteName}</div></td>
                    <td data-h="Status"><span className="row wrap" style={{ gap: 6 }}><StatusChip status={r.status} /><OverdueBadge o={r.overdue} />{r.archived && <Badge tone="neutral" outline>Archived</Badge>}</span></td>
                    {!resident && <td data-h="Held by">{r.holder ? <Person name={r.holder.name} sub={`${r.holder.employeeId}${r.holder.left ? ' · has left' : ''}`} /> : <span className="muted">In the cabinet</span>}</td>}
                    <td data-h="Due">{r.status === 'issued' ? (r.dueBack ? fmtDate(r.dueBack) : <span className="muted">With the stay</span>) : <span className="muted">-</span>}</td>
                  </tr>
                ))}
                {rows.length === 0 && <tr><td colSpan={resident ? 4 : 5}><div className="tbl-empty">{q ? 'Nothing matches that search.' : filter.id === '' ? 'Nothing is out at the moment.' : 'Nothing matches this filter.'}</div></td></tr>}
              </tbody>
            </table>
          </div>
        </GlassCard>
      </div>
    </>
  )
}
