import { notFound } from 'next/navigation'
import { requirePage } from '@/server/auth/page'
import { viewStaff } from '@/server/commands/staff/read'
import { PageHeader } from '@/ui'
import { Profile } from '../_components/Profile'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'My profile · Grand Hyatt Staff Accommodation' }

export default async function MyProfile() {
  const cur = await requirePage()
  if (!cur.rc.user.staffId) notFound()
  const r = await viewStaff(cur.rc, cur.rc.user.staffId)
  if (!r.ok) notFound()
  return (
    <>
      <PageHeader crumbs={['People']} title="My profile" summary="The details held about you. Employee ID is your sign-in name unless told otherwise." />
      <Profile shape={r.data.shape} staff={r.data.staff} canManage={false} />
    </>
  )
}
