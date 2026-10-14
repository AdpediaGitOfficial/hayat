import { notFound } from 'next/navigation'
import { requirePage } from '@/server/auth/page'
import { getDb } from '@/server/db/client'
import { TEMPLATE_EXAMPLE, TEMPLATE_HEADER } from '@/server/commands/staff/importRules'
import { getImportBatch } from '@/server/queries/staff/imports'
import { PageHeader } from '@/ui'
import { ImportWizard, type WizardBatch } from '../../_components/ImportWizard'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Import staff · Grand Hyatt Staff Accommodation' }

/** Reopen a batch: the preview if it is still waiting, the result once confirmed. */
export default async function ImportBatchPage({ params }: { params: { batchId: string } }) {
  const cur = await requirePage('staff_directory.import_csv')
  const b = await getImportBatch(getDb(), { actor: cur.rc.actor, userId: cur.rc.user.id }, params.batchId)
  if (!b) notFound()
  const initial = JSON.parse(JSON.stringify(b)) as WizardBatch
  return (
    <>
      <PageHeader crumbs={['People', 'Staff directory', 'Import']} title={b.status === 'confirmed' ? 'Import result' : 'Import preview'} />
      <ImportWizard initial={initial} templateHeader={TEMPLATE_HEADER} templateExample={TEMPLATE_EXAMPLE} />
    </>
  )
}
