import Link from 'next/link'
import { requirePage } from '@/server/auth/page'
import { todayInZone } from '@/server/commands/property/shared'
import { PageHeader } from '@/ui'
import { BulkExit } from '../_components/BulkExit'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Mark several people as Left · Grand Hyatt Staff Accommodation' }

export default async function BulkExitPage() {
  const cur = await requirePage('exit_clearance.mark_left')
  return (
    <>
      <PageHeader crumbs={['Accommodation', 'Exits & clearance']} title="Mark several people as Left"
        summary="Preview first: every row says what will happen or why it cannot. Nobody is changed until you confirm with your password."
        actions={<Link href="/exits" className="btn ghost" style={{ textDecoration: 'none' }}>All cases</Link>} />
      <div style={{ maxWidth: 720 }}>
        <BulkExit today={todayInZone(cur.rc.clock.now(), 'UTC')} />
      </div>
    </>
  )
}
