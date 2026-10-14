import { notFound } from 'next/navigation'
import { requirePage } from '@/server/auth/page'
import { getDb } from '@/server/db/client'
import { requestableSites } from '@/server/queries/requests/preview'
import { PageHeader } from '@/ui'
import { RequestForm } from '../_components/RequestForm'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Request a bed · Grand Hyatt Staff Accommodation' }

export default async function NewRequest() {
  const cur = await requirePage('requests_waitlist.submit')
  const { actor } = cur.rc
  const sites = await requestableSites(getDb(), actor)
  if (actor.role === 'Res' && !actor.staffId) notFound()
  const onBehalf = actor.role !== 'Res'
  return (
    <>
      <PageHeader eyebrow={onBehalf ? 'Accommodation' : 'Resident'} title={onBehalf ? 'New request for staff' : 'Request a bed'}
        summary={onBehalf ? 'File a request for a colleague at one of your sites. They are notified and it is audited.' : 'Where your request, offer, reservation or stay stands is on My accommodation.'} />
      <RequestForm sites={sites.map(s => ({ id: s.id, name: s.name }))} today={cur.rc.clock.now().toISOString().slice(0, 10)} onBehalf={onBehalf} />
    </>
  )
}
