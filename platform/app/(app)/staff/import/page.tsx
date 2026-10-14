import { requirePage } from '@/server/auth/page'
import { TEMPLATE_EXAMPLE, TEMPLATE_HEADER } from '@/server/commands/staff/importRules'
import { PageHeader } from '@/ui'
import { ImportWizard } from '../_components/ImportWizard'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Import staff · Grand Hyatt Staff Accommodation' }

export default async function ImportStaff() {
  await requirePage('staff_directory.import_csv')
  return (
    <>
      <PageHeader crumbs={['People', 'Staff directory']} title="Import staff from CSV" summary="Preview first, then confirm. Duplicates are never merged. Rejected rows come back as a file with the reason for each." />
      <ImportWizard templateHeader={TEMPLATE_HEADER} templateExample={TEMPLATE_EXAMPLE} />
    </>
  )
}
