/// <reference types="vite/client" />
/**
 * AT-038 (waitlist priority rows). The decision on a waitlist priority request needs the global list of priority categories (GH-04 is open and
 * empty by default), so it runs in a private database. Same rule as the table in sod-matrix.test.ts: the person the entry is about and the person who
 * asked for the priority are refused with `separation_of_duties`, nothing changes and nothing is audited; an independent Policy Approver succeeds.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createIsolated } from '../access/isolated'
import { invKit, day } from './kit'
import { addToWaitlist } from '@/server/commands/waitlist/add'
import { decidePriority, requestPriority } from '@/server/commands/waitlist/priority'

const iso = await createIsolated()
afterAll(() => iso.close())
const k = invKit(iso)

let site: string
beforeAll(async () => {
  site = (await k.property({ beds: 3 })).siteId
  await k.setConfig('eligibility.priority_categories', ['Medical'])
})

describe('AT-038 waitlist priority', () => {
  it.each(['approve', 'reject'] as const)('%s a priority request: refused for the person it is about and for the one who asked; an independent Policy Approver succeeds', async decision => {
    // the person on the waitlist is also a Policy Approver (an admin waiting for a bed); the asker is an Accommodation Admin who also holds the capability
    const subject = await k.cast('Mgr', { siteId: site, caps: ['PolicyApprover'] })
    const asker = await k.cast('AA', { siteId: site, caps: ['PolicyApprover'] })
    const independent = await k.cast('Mgr', { siteId: site, caps: ['PolicyApprover'] })
    const e = await addToWaitlist(asker.rc(), { staffId: subject.staffId, siteId: site, arrival: day(5) })
    if (!e.ok) throw new Error('waitlist: ' + e.reason)
    const p = await requestPriority(asker.rc(), { entryId: e.data.entryId, category: 'Medical', reason: 'needs a ground floor', evidence: 'doctor letter' })
    if (!p.ok) throw new Error('priority: ' + p.reason)
    const id = p.data.priorityRequestId
    const state = async () => JSON.stringify([
      (await iso.admin.query(`SELECT status FROM waitlist_priority_request WHERE id = $1`, [id])).rows,
      (await iso.admin.query(`SELECT priority FROM waitlist_entry WHERE id = $1`, [e.data.entryId])).rows,
      (await iso.admin.query(`SELECT count(*)::int AS n FROM audit_event WHERE entity_id = $1`, [id])).rows,
    ])
    const before = await state()
    const run = (w: { rc: () => any }) => decidePriority(w.rc(), { priorityRequestId: id, decision, note: 'Confirmed' })
    for (const w of [subject, asker]) {
      const r = await run(w)
      expect(r.ok).toBe(false)
      expect(!r.ok && r.code).toBe('separation_of_duties')
      expect(await state()).toBe(before)
    }
    expect((await run(independent)).ok).toBe(true)
  })
})
