import { notFound } from 'next/navigation'
import { requirePage } from '@/server/auth/page'
import { getDb } from '@/server/db/client'
import { getConfig } from '@/server/config/registry'
import { can } from '@/server/policy'
import { selectableSites } from '@/server/queries/access/sites'
import { listQueues, queueSites } from '@/server/queries/waitlist/queue'
import { Board, type Perms } from './_components/Board'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Waitlist · Grand Hyatt Staff Accommodation' }

/**
 * Waitlist and bed offers for staff: the queue of each site in order, the offers in flight with their timers, and the actions each role
 * may take (offer, renew, priority, decide priority, record "informed offline", accept on behalf, withdraw). A resident has no use for
 * this page: their own entry and offers are on "My accommodation".
 */
export default async function WaitlistPage() {
  const cur = await requirePage()
  const { actor } = cur.rc
  const scope = queueSites(actor)
  if (scope !== 'all' && scope.length === 0) notFound()

  const db = getDb()
  const perms: Perms = {
    add: can(actor, 'requests_waitlist.submit'),
    manage: can(actor, 'requests_waitlist.manage_waitlist'),
    offer: can(actor, 'requests_waitlist.manage_offers'),
    offline: can(actor, 'requests_waitlist.record_offline_offer') || can(actor, 'requests_waitlist.manage_offers'),
    behalf: can(actor, 'requests_waitlist.accept_offer_on_behalf') || can(actor, 'requests_waitlist.manage_offers'),
    decide: can(actor, 'requests_waitlist.approve_exception'),
  }
  const [queues, sites, categories] = await Promise.all([
    listQueues(db, actor),
    perms.add ? selectableSites(actor, 'requests_waitlist.submit') : Promise.resolve([]),
    getConfig(db, 'eligibility.priority_categories'),
  ])
  return <Board queues={queues} sites={sites.map(s => ({ id: s.id, name: s.name }))} categories={categories} perms={perms} />
}
