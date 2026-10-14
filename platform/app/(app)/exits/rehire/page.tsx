import Link from 'next/link'
import { requirePage } from '@/server/auth/page'
import { can } from '@/server/policy'
import { PageHeader } from '@/ui'
import { RehireForm } from '../_components/RehireForm'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Rehire · Grand Hyatt Staff Accommodation' }

export default async function RehirePage({ searchParams }: { searchParams: { employeeId?: string } }) {
  const cur = await requirePage('staff_directory.manage')
  const employeeId = typeof searchParams.employeeId === 'string' ? searchParams.employeeId.slice(0, 60) : undefined
  return (
    <>
      <PageHeader crumbs={['Accommodation', 'Exits & clearance']} title="Rehire"
        summary="A former employee returns on their existing profile. Blocked while they are still in a bed or while an old clearance case has mandatory items open."
        actions={<Link href="/exits" className="btn ghost" style={{ textDecoration: 'none' }}>All cases</Link>} />
      <div style={{ maxWidth: 680 }}>
        <RehireForm initialEmployeeId={employeeId} canManageAccounts={can(cur.rc.actor, 'users_roles.manage_staff_accounts')} />
      </div>
    </>
  )
}
