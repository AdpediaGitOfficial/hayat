import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requirePage } from '@/server/auth/page'
import { can } from '@/server/policy'
import { viewStaff } from '@/server/commands/staff/read'
import { PageHeader } from '@/ui'
import { Profile } from '../_components/Profile'

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
        actions={<Link href="/staff" className="btn secondary" style={{ textDecoration: 'none' }}>Back to directory</Link>} />
      <Profile shape={r.data.shape} staff={r.data.staff} canManage={can(cur.rc.actor, 'staff_directory.manage')} />
    </>
  )
}
