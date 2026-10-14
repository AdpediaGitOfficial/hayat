import Link from 'next/link'
import { requirePage } from '@/server/auth/page'
import { PageHeader } from '@/ui'
import { todayInZone } from '@/server/commands/property/shared'
import { MarkLeftForm } from '../_components/MarkLeftForm'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Mark as Left · Grand Hyatt Staff Accommodation' }

export default async function NewExitPage({ searchParams }: { searchParams: { employeeId?: string } }) {
  const cur = await requirePage('exit_clearance.mark_left')
  const employeeId = typeof searchParams.employeeId === 'string' ? searchParams.employeeId.slice(0, 60) : undefined
  return (
    <>
      <PageHeader crumbs={['Accommodation', 'Exits & clearance']} title="Mark as Left"
        summary="Ends the login at once and opens a clearance case. The stay and the bed are not touched: only an actual checkout releases the bed."
        actions={<><Link href="/exits/bulk" className="btn secondary" style={{ textDecoration: 'none' }}>Mark several people</Link><Link href="/exits" className="btn ghost" style={{ textDecoration: 'none' }}>All cases</Link></>} />
      <div style={{ maxWidth: 680 }}>
        <MarkLeftForm initialEmployeeId={employeeId} today={todayInZone(cur.rc.clock.now(), 'UTC')} />
      </div>
    </>
  )
}
