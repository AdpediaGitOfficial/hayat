import { notFound } from 'next/navigation'
import { requirePage } from '@/server/auth/page'
import { viewStaff } from '@/server/commands/staff/read'
import type { StaffFull } from '@/server/queries/staff/shapes'
import { PageHeader } from '@/ui'
import { StaffForm } from '../../_components/StaffForm'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Edit staff · Grand Hyatt Staff Accommodation' }

export default async function EditStaff({ params }: { params: { id: string } }) {
  const cur = await requirePage('staff_directory.manage')
  const r = await viewStaff(cur.rc, params.id)
  if (!r.ok || r.data.shape !== 'full') notFound()
  const s = r.data.staff as StaffFull
  if (s.archivedAt) notFound()
  return (
    <>
      <PageHeader crumbs={['People', 'Staff directory', s.fullName]} title="Edit staff" />
      <StaffForm id={s.id} initial={{
        employeeId: s.employeeId, fullName: s.fullName, gender: s.gender ?? '', department: s.department ?? '', grade: s.grade === null ? '' : String(s.grade),
        phone: s.phone ?? '', email: s.email ?? '', emergencyContact: s.emergencyContact ?? '', joiningDate: s.joiningDate ?? '',
      }} />
    </>
  )
}
