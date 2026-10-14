import Link from 'next/link'
import { requirePage } from '@/server/auth/page'
import { getDb } from '@/server/db/client'
import { can } from '@/server/policy'
import { listCases } from '@/server/queries/exit/cases'
import { GlassCard, PageHeader } from '@/ui'
import { CaseChip, DueChip } from './_components/chips'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Exits & clearance · Grand Hyatt Staff Accommodation' }

const SCOPES = [['open', 'Open'], ['cleared', 'Cleared'], ['all', 'All']] as const

export default async function ExitsPage({ searchParams }: { searchParams: { q?: string; scope?: string; overdue?: string } }) {
  const cur = await requirePage('exit_clearance.view')
  const { actor } = cur.rc
  const q = typeof searchParams.q === 'string' ? searchParams.q.slice(0, 80) : ''
  const scope = searchParams.scope === 'cleared' || searchParams.scope === 'all' ? searchParams.scope : 'open'
  const overdueOnly = searchParams.overdue === '1'
  const cases = await listCases(getDb(), actor, { q, scope, overdueOnly, now: cur.rc.clock.now() })
  const open = cases.filter(c => c.status !== 'cleared')
  const overdue = open.filter(c => c.overdue).length
  const href = (o: { scope?: string; overdue?: boolean }) => `/exits?${new URLSearchParams({ ...(q ? { q } : {}), scope: o.scope ?? scope, ...(o.overdue ?? overdueOnly ? { overdue: '1' } : {}) }).toString()}`

  return (
    <>
      <PageHeader eyebrow="Accommodation" title="Exits & clearance"
        summary="Employees who left, and what is still to be cleared: keys, assets, the room, belongings. Checkout, clearance and a ready bed are three separate things."
        actions={<>
          {can(actor, 'exit_clearance.mark_left') && <Link href="/exits/new" className="btn primary" style={{ textDecoration: 'none' }}>Mark as Left</Link>}
          {can(actor, 'exit_clearance.mark_left') && <Link href="/exits/bulk" className="btn secondary" style={{ textDecoration: 'none' }}>Several people</Link>}
          {can(actor, 'staff_directory.manage') && <Link href="/exits/rehire" className="btn secondary" style={{ textDecoration: 'none' }}>Rehire</Link>}
        </>} />

      <GlassCard strong flush>
        <form method="get" action="/exits" className="row wrap" style={{ padding: '16px 20px', gap: 10 }} role="search">
          <input className="input" name="q" defaultValue={q} placeholder="Name or employee ID" aria-label="Search cases" style={{ maxWidth: 280 }} />
          <select className="select" name="scope" defaultValue={scope} aria-label="Show" style={{ maxWidth: 160 }}>
            {SCOPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <label className="check"><input type="checkbox" name="overdue" value="1" defaultChecked={overdueOnly} />Overdue only</label>
          <button className="btn secondary" type="submit">Search</button>
          <span className="spacer" />
          <span className="muted body-sm">{scope === 'cleared' ? `${cases.length} cleared` : `${open.length} open${overdue ? `, ${overdue} overdue` : ''}`}</span>
        </form>
        {cases.length === 0
          ? <div className="tbl-empty" data-testid="exits-empty">{q || overdueOnly ? 'No case matches.' : scope === 'cleared' ? 'No cleared cases yet.' : 'No open clearance cases.'}{' '}<Link href={href({ scope: 'all', overdue: false })}>Show all</Link></div>
          : (
            <ul className="list-plain" style={{ padding: '0 20px 8px' }} aria-label="Clearance cases">
              {cases.map(c => (
                <li key={c.id} style={{ flexWrap: 'wrap', alignItems: 'flex-start' }} data-case={c.id}>
                  <div style={{ flex: 1, minWidth: 220 }}>
                    <Link href={`/exits/${c.id}`}><b>{c.fullName}</b></Link>
                    <div className="muted body-sm">{c.employeeId}{c.siteName ? ` · ${c.siteName}` : ' · no site'} · left effective {c.effectiveDate}</div>
                    {c.status !== 'cleared' && c.nextOwner && (
                      <div className="body-sm" style={{ marginTop: 4 }}>
                        {c.pendingMandatory} mandatory item{c.pendingMandatory === 1 ? '' : 's'} to go · <span className="muted">next: {c.nextOwner}, {c.nextItem}</span>
                      </div>
                    )}
                    {c.status !== 'cleared' && !c.nextOwner && <div className="body-sm muted" style={{ marginTop: 4 }}>Every mandatory item is done or waived: ready to close.</div>}
                  </div>
                  <div className="row wrap" style={{ justifyContent: 'flex-end' }}>
                    <CaseChip status={c.status} />
                    {c.status !== 'cleared' && <DueChip dueDate={c.dueDate} overdue={c.overdue} daysOverdue={c.daysOverdue} />}
                  </div>
                </li>
              ))}
            </ul>
          )}
      </GlassCard>
    </>
  )
}
