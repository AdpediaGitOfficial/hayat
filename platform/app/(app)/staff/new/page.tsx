import { requirePage } from '@/server/auth/page'
import { PageHeader } from '@/ui'
import { StaffForm } from '../_components/StaffForm'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Add staff · Grand Hyatt Staff Accommodation' }

export default async function NewStaff() {
  await requirePage('staff_directory.manage')
  return (
    <>
      <PageHeader crumbs={['People', 'Staff directory']} title="Add staff" summary="A duplicate employee ID is refused and never merged." />
      <StaffForm />
    </>
  )
}
