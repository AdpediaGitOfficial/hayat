import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requirePage } from '@/server/auth/page'
import { can } from '@/server/policy'
import { viewStaff } from '@/server/commands/staff/read'
import { PageHeader } from '@/ui'
import { Profile } from '../_components/Profile'
import { MarkLeftButton, RehireButton } from '../../exits/_components/MarkLeftButton'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Staff profile · Grand Hyatt Staff Accommodation' }

export default async function StaffDetail({ params }: { params: { id: string } }) {
  const cur = await requirePage()
  const r = await viewStaff(cur.rc, params.id)
  // Everything the role may not see is the same plain "not found" page, whether or not the person exists (AT-001).
  if (!r.ok) notFound()
  return (
    <>
      <PageHeader crumbs={['People', 'Staff directory']} title="Staff profile"
        actions={<>
          {r.data.staff.employmentStatus === 'active' && can(cur.rc.actor, 'exit_clearance.mark_left') && <MarkLeftButton employeeId={r.data.staff.employeeId} />}
          {r.data.staff.employmentStatus === 'left' && can(cur.rc.actor, 'staff_directory.manage') && <RehireButton employeeId={r.data.staff.employeeId} />}
          <Link href="/staff" className="btn secondary" style={{ textDecoration: 'none' }}>Back to directory</Link>
        </>} />
      <Profile shape={r.data.shape} staff={r.data.staff} canManage={can(cur.rc.actor, 'staff_directory.manage')} />
    </>
  )
}
