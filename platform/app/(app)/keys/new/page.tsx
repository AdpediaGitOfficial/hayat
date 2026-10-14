import Link from 'next/link'
import { requirePage } from '@/server/auth/page'
import { getDb } from '@/server/db/client'
import { getConfig } from '@/server/config/registry'
import { linkOptions } from '@/server/queries/keys/items'
import { PageHeader } from '@/ui'
import { NewItemForm } from '../_components/NewItemForm'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Add keys · Grand Hyatt Staff Accommodation' }

export default async function NewKeys() {
  const cur = await requirePage('keys.manage')
  const [types, options] = await Promise.all([getConfig(getDb(), 'keys.item_types'), linkOptions(cur.rc.actor)])
  return (
    <>
      <PageHeader crumbs={['Accommodation', 'Keys & assets', 'Add']} title="Add keys and assets" summary="Super Admin and Accommodation Admin add items to the cabinet of their sites. Nothing is ever deleted: an item that is no longer needed is retired or archived."
        actions={<Link href="/keys" className="btn secondary" style={{ textDecoration: 'none' }}>Back to keys</Link>} />
      <NewItemForm types={types} options={options} />
    </>
  )
}
