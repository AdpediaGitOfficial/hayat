'use client'
/** State chips, "has a reservation" toggle and search for the inventory tree. The filter lives in the URL, so it can be shared and survives a refresh. */
import { usePathname, useRouter } from 'next/navigation'
import { useState, type FormEvent } from 'react'
import { Button, Check, Input, Tabs } from '@/ui'
import type { BedStateDb } from '@/domain/enums'
import type { StateCounts, TreeFilter } from '@/server/queries/property/types'
import { STATE_NAME } from './state'

type Chip = 'all' | Exclude<BedStateDb, 'archived'>
const CHIPS: Chip[] = ['all', 'available', 'occupied', 'needs_cleaning', 'inspection_required', 'blocked', 'under_maintenance']

export function TreeToolbar({ counts, filter }: { counts: StateCounts; filter: TreeFilter }) {
  const router = useRouter()
  const path = usePathname()
  const [q, setQ] = useState(filter.q ?? '')

  function go(next: TreeFilter) {
    const sp = new URLSearchParams()
    if (next.state) sp.set('state', next.state)
    if (next.reserved) sp.set('reserved', '1')
    if (next.q) sp.set('q', next.q)
    if (next.includeArchived) sp.set('archived', '1')
    const qs = sp.toString()
    router.push(qs ? `${path}?${qs}` : path)
  }
  const current: Chip = filter.state && filter.state !== 'archived' ? filter.state : 'all'

  return (
    <div className="stack" style={{ gap: 12 }}>
      <div style={{ overflowX: 'auto', paddingBottom: 2 }}>
        <Tabs<Chip> value={current} onChange={c => go({ ...filter, state: c === 'all' ? undefined : c })}
          options={CHIPS.map(c => ({ id: c, label: c === 'all' ? 'All' : STATE_NAME[c], count: c === 'all' ? counts.total : counts[c] }))} />
      </div>
      <form className="row wrap" role="search" onSubmit={(e: FormEvent) => { e.preventDefault(); go({ ...filter, q: q.trim() || undefined }) }}>
        <div style={{ flex: '1 1 220px', maxWidth: 360 }}>
          <Input aria-label="Search beds, rooms and buildings" placeholder="Search bed, room or building" value={q} onChange={e => setQ(e.target.value)} />
        </div>
        <Button type="submit" icon="search">Search</Button>
        {(filter.q || filter.state || filter.reserved) && <Button variant="ghost" onClick={() => { setQ(''); go({ includeArchived: filter.includeArchived }) }}>Clear filters</Button>}
        <Check checked={!!filter.reserved} onChange={v => go({ ...filter, reserved: v || undefined })}>With a dated reservation</Check>
        <Check checked={!!filter.includeArchived} onChange={v => go({ ...filter, includeArchived: v || undefined })}>Show archived</Check>
      </form>
    </div>
  )
}
