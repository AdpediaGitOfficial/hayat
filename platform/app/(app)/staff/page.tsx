import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { requirePage } from '@/server/auth/page'
import { getDb } from '@/server/db/client'
import { can } from '@/server/policy'
import { staffAccess } from '@/server/queries/staff/access'
import { listDepartments, listStaff, MIN_SEARCH } from '@/server/queries/staff/list'
import type { StaffFull, StaffMinimum } from '@/server/queries/staff/shapes'
import { Alert, Badge, GlassCard, Icon, PageHeader, Person, Status } from '@/ui'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Staff directory · Grand Hyatt Staff Accommodation' }

type SP = Record<string, string | string[] | undefined>
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? ''
const PAGE = 25

export default async function StaffDirectory({ searchParams }: { searchParams: SP }) {
  const cur = await requirePage()
  const { actor } = cur.rc
  const access = staffAccess(actor)
  if (!access) notFound()
  if (access.ownOnly) redirect('/staff/me')

  const q = one(searchParams.q).trim()
  const department = one(searchParams.department)
  const status = one(searchParams.status) === 'left' ? 'left' : one(searchParams.status) === 'active' ? 'active' : undefined
  const archived = one(searchParams.archived) === '1'
  const page = Math.max(1, Number(one(searchParams.page)) || 1)

  const db = getDb()
  const [list, departments] = await Promise.all([
    listStaff(db, actor, { q, department, status, includeArchived: archived, limit: PAGE, offset: (page - 1) * PAGE }),
    listDepartments(db, actor),
  ])
  if (!list) notFound()

  const full = list.shape === 'full'
  const canManage = can(actor, 'staff_directory.manage')
  const canImport = can(actor, 'staff_directory.import_csv')
  const showDept = list.shape === 'full' || list.shape === 'minimum'
  const pages = Math.max(1, Math.ceil(list.total / PAGE))
  const link = (p: number) => {
    const u = new URLSearchParams()
    if (q) u.set('q', q)
    if (department) u.set('department', department)
    if (status) u.set('status', status)
    if (archived) u.set('archived', '1')
    if (p > 1) u.set('page', String(p))
    const s = u.toString()
    return `/staff${s ? '?' + s : ''}`
  }

  return (
    <>
      <PageHeader
        crumbs={['People']} title="Staff directory"
        summary={full ? 'Employee ID is the unique business key. Entered by hand or by CSV; there is no HR system link.'
          : list.shape === 'minimum' ? 'Look a person up by name or employee ID. You see the minimum: name, ID, department and status.'
          : 'Identity check: name, employee ID and status.'}
        actions={<>
          {canImport && <Link href="/staff/import" className="btn secondary" style={{ textDecoration: 'none' }}><Icon name="upload" />Import CSV</Link>}
          {canManage && <Link href="/staff/new" className="btn primary" style={{ textDecoration: 'none' }}><Icon name="userPlus" />Add staff</Link>}
        </>}
      />

      <GlassCard strong flush
        footer={<>
          <span>{list.needsSearch ? 'Search to see people' : `${list.total} ${list.total === 1 ? 'person' : 'people'}${list.total > PAGE ? ` · page ${page} of ${pages}` : ''}`}</span>
          {pages > 1 && !list.needsSearch && (
            <span className="row">
              {page > 1 && <Link href={link(page - 1)} className="btn ghost sm" style={{ textDecoration: 'none' }} rel="prev">Previous</Link>}
              {page < pages && <Link href={link(page + 1)} className="btn ghost sm" style={{ textDecoration: 'none' }} rel="next">Next</Link>}
            </span>
          )}
        </>}>
        <form className="tbl-tool" style={{ paddingTop: 16 }} method="get" role="search" aria-label="Search staff">
          <label className="search" style={{ margin: 0, maxWidth: 320 }}>
            <Icon name="search" />
            <input name="q" defaultValue={q} placeholder="Search name or employee ID" aria-label="Search staff" autoComplete="off" />
          </label>
          {showDept && (
            <select className="select" name="department" defaultValue={department} aria-label="Department" style={{ maxWidth: 200 }}>
              <option value="">All departments</option>
              {departments.map(d => <option key={d} value={d}>{d}</option>)}
            </select>
          )}
          <select className="select" name="status" defaultValue={status ?? ''} aria-label="Employment status" style={{ maxWidth: 160 }}>
            <option value="">Any status</option>
            <option value="active">Active</option>
            <option value="left">Left</option>
          </select>
          {full && <label className="check"><input type="checkbox" name="archived" value="1" defaultChecked={archived} />Include archived</label>}
          <button className="btn secondary" type="submit">Search</button>
        </form>

        {list.needsSearch ? (
          <div className="tbl-empty">
            <Icon name="search" size={20} />
            <div>Type at least {MIN_SEARCH} characters of a name or employee ID, then press Search.</div>
          </div>
        ) : (
          <div className="tbl-wrap">
            <table className="tbl stack-m">
              <thead>
                <tr>
                  <th>Person</th><th>Employee ID</th>
                  {showDept && <th>Department</th>}
                  {full && <th>Grade</th>}
                  {full && <th>Phone</th>}
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {list.items.map(row => {
                  const r = row as StaffFull & StaffMinimum
                  return (
                    <tr key={r.id}>
                      <td data-h="Person"><Link href={`/staff/${r.id}`} style={{ textDecoration: 'none', color: 'inherit' }}><Person name={r.fullName} sub={full && r.gender ? (r.gender === 'male' ? 'Male' : 'Female') : undefined} /></Link></td>
                      <td data-h="Employee ID"><span className="mono">{r.employeeId}</span></td>
                      {showDept && <td data-h="Department">{r.department ?? <span className="muted">·</span>}</td>}
                      {full && <td data-h="Grade" className="tnum">{r.grade ?? <span className="muted">·</span>}</td>}
                      {full && <td data-h="Phone"><span className="mono">{r.phone ?? '·'}</span></td>}
                      <td data-h="Status">
                        {r.archivedAt ? <Badge tone="neutral">Archived</Badge> : <Status s={r.employmentStatus === 'left' ? 'Left' : 'Active'} />}
                      </td>
                    </tr>
                  )
                })}
                {list.items.length === 0 && <tr><td colSpan={6}><div className="tbl-empty">No one matches. Check the spelling, or search by employee ID.</div></td></tr>}
              </tbody>
            </table>
          </div>
        )}
      </GlassCard>
      {list.shape !== 'full' && <Alert tone="info" title="Limited view" detail="Phone, email, grade and emergency contact are visible to administrators only." />}
    </>
  )
}
