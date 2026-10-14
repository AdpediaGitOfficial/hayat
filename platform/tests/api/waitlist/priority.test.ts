/**
 * Waitlist priority exception (D-53, GH-04 open). The category list is global configuration, so everything that depends on it lives in
 * this one file and the "no categories yet" test runs first.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { admin, call, closeAll } from '../harness'
import { mkStaff, setConfigValue } from '../fixtures2'
import { audits, cookieOf, entryRow, notes, person, window, world } from './helpers'
import { setClock } from '@/server/runtime'
import { addToWaitlist } from '@/server/commands/waitlist/add'
import { decidePriority, requestPriority } from '@/server/commands/waitlist/priority'
import { listInbox } from '@/server/approvals/inbox'
import { getDb } from '@/server/db/client'
import { POST as decideRoute } from '../../../app/api/v1/waitlist/priority/[id]/decide/route'
import { POST as requestRoute } from '../../../app/api/v1/waitlist/[id]/priority/route'
import type { Actor } from '@/server/policy'

afterAll(closeAll)

async function queued(w: Awaited<ReturnType<typeof world>>, win: ReturnType<typeof window>, n: number) {
  const out: { entryId: string; staffId: string }[] = []
  for (let i = 0; i < n; i++) {
    win.clock.advance(3600_000)
    const s = await mkStaff()
    const r = await addToWaitlist(w.rec.rc(win.clock), { staffId: s.id, siteId: w.siteId, arrival: win.day(5) })
    if (!r.ok) throw new Error(r.reason)
    out.push({ entryId: r.data.entryId, staffId: s.id })
  }
  return out
}
const pos = async (entryId: string, siteId: string) => {
  const { queuePosition } = await import('@/server/commands/waitlist/queue')
  return queuePosition(getDb(), siteId, entryId)
}

describe('priority exception', () => {
  it('nothing can be requested until Grand Hyatt defines the categories (GH-04): the refusal says who and what is next', async () => {
    const w = await world()
    const win = window()
    const [a] = await queued(w, win, 1)
    const r = await requestPriority(w.aa.rc(win.clock), { entryId: a.entryId, category: 'Medical', reason: 'doctor note', evidence: 'letter 12' })
    expect(r.ok).toBe(false)
    if (!r.ok) { expect(r.owner).toBe('Super Admin'); expect(r.reason).toMatch(/GH-04/); expect((r.detail as any).reason).toBe('no_categories') }
  })

  it('request by the Accommodation Admin, decision by the Policy Approver: the person moves ahead, with the history recorded', async () => {
    await setConfigValue('eligibility.priority_categories', ['Medical', 'Safety'])
    const w = await world()
    const win = window()
    const [a, b, c] = await queued(w, win, 3)
    expect(await pos(c.entryId, w.siteId)).toBe(3)

    // must be an approved category, with reason and evidence
    expect((await requestPriority(w.aa.rc(win.clock), { entryId: c.entryId, category: 'VIP', reason: 'because', evidence: 'none' })).ok).toBe(false)
    const bad = await requestPriority(w.aa.rc(win.clock), { entryId: c.entryId, category: 'Medical', reason: 'doctor note', evidence: '' })
    expect(bad.ok).toBe(false)

    const req = await requestPriority(w.aa.rc(win.clock), { entryId: c.entryId, category: 'Medical', reason: 'needs ground floor', evidence: 'medical letter 14 Oct' })
    expect(req.ok).toBe(true)
    const rid = req.ok ? req.data.priorityRequestId : ''
    expect((await requestPriority(w.aa.rc(win.clock), { entryId: c.entryId, category: 'Safety', reason: 'again', evidence: 'x y z' })).ok).toBe(false) // one pending per entry
    expect(await pos(c.entryId, w.siteId)).toBe(3) // asking changes nothing
    expect((await notes(`waitlist:priority:${rid}:requested`))[0]).toMatchObject({ to_role: 'PolicyApprover', site_id: w.siteId })

    // it shows up in the approvals inbox of the Policy Approver
    const paActor: Actor = { role: 'AA', caps: ['PolicyApprover'], sites: [w.siteId], staffId: w.pa.staffId }
    const inbox = await listInbox(getDb(), paActor, win.clock.now())
    expect(inbox.find(i => i.ref === rid)).toMatchObject({ kind: 'waitlist_priority', mine: true, current: 'Policy Approver' })
    // ...but the Accommodation Admin who asked sees it as theirs to wait for (not decidable by them)
    const aaInbox = await listInbox(getDb(), { role: 'AA', caps: [], sites: [w.siteId], staffId: w.aa.staffId }, win.clock.now())
    expect(aaInbox.find(i => i.ref === rid)?.mine ?? false).toBe(false)

    win.clock.advance(3600_000)
    const d = await decidePriority(w.pa.rc(win.clock), { priorityRequestId: rid, decision: 'approve', note: 'confirmed' })
    expect(d.ok).toBe(true)
    if (d.ok) expect(d.data).toEqual({ positionBefore: 3, positionAfter: 1 })
    expect(await pos(c.entryId, w.siteId)).toBe(1)
    expect(await pos(a.entryId, w.siteId)).toBe(2)
    expect(await pos(b.entryId, w.siteId)).toBe(3)
    expect((await entryRow(c.entryId)).priority).toBe('Medical')
    const row = (await admin().query(`SELECT status, decided_by, position_before, position_after, evidence FROM waitlist_priority_request WHERE id = $1`, [rid])).rows[0]
    expect(row).toMatchObject({ status: 'approved', decided_by: w.pa.user.id, position_before: 3, position_after: 1, evidence: 'medical letter 14 Oct' })
    const au = await audits(rid)
    expect(au.map(x => x.action)).toEqual(['waitlist.priority.requested', 'waitlist.priority.approved'])
    expect(au[1].before).toMatchObject({ priorSequence: 3 })
    expect(au[1].after).toMatchObject({ newSequence: 1, category: 'Medical' })
    // decided once
    expect((await decidePriority(w.pa.rc(win.clock), { priorityRequestId: rid, decision: 'reject', note: 'oops' })).ok).toBe(false)
    // the inbox no longer lists it
    expect((await listInbox(getDb(), paActor, win.clock.now())).some(i => i.ref === rid)).toBe(false)
  })

  it('a higher category outranks a lower one; within a category the oldest first', async () => {
    const w = await world()
    const win = window()
    const [a, b, c] = await queued(w, win, 3)
    for (const [e, cat] of [[b, 'Safety'], [c, 'Medical']] as const) {
      const r = await requestPriority(w.aa.rc(win.clock), { entryId: e.entryId, category: cat, reason: 'needed', evidence: 'on file' })
      expect(r.ok).toBe(true)
      const d = await decidePriority(w.pa.rc(win.clock), { priorityRequestId: r.ok ? r.data.priorityRequestId : '', decision: 'approve' })
      expect(d.ok).toBe(true)
    }
    expect([await pos(c.entryId, w.siteId), await pos(b.entryId, w.siteId), await pos(a.entryId, w.siteId)]).toEqual([1, 2, 3])
  })

  it('rejection needs a reason and changes no position', async () => {
    const w = await world()
    const win = window()
    const [a, b] = await queued(w, win, 2)
    const r = await requestPriority(w.aa.rc(win.clock), { entryId: b.entryId, category: 'Safety', reason: 'asked nicely', evidence: 'email' })
    const rid = r.ok ? r.data.priorityRequestId : ''
    const noReason = await decidePriority(w.pa.rc(win.clock), { priorityRequestId: rid, decision: 'reject' })
    expect(noReason.ok).toBe(false)
    expect((await decidePriority(w.pa.rc(win.clock), { priorityRequestId: rid, decision: 'reject', note: 'not covered by the policy' })).ok).toBe(true)
    expect([await pos(a.entryId, w.siteId), await pos(b.entryId, w.siteId)]).toEqual([1, 2])
    expect((await entryRow(b.entryId)).priority).toBeNull()
  })

  it('separation of duties: a Policy Approver cannot decide their own entry, nor a request they raised; nobody without the capability can decide', async () => {
    const w = await world()
    const win = window()
    // the Policy Approver is on the waitlist themselves
    const own = await addToWaitlist(w.rec.rc(win.clock), { staffId: w.pa.staffId, siteId: w.siteId, arrival: win.day(5) })
    const r = await requestPriority(w.aa.rc(win.clock), { entryId: own.ok ? own.data.entryId : '', category: 'Medical', reason: 'needed', evidence: 'letter' })
    const rid = r.ok ? r.data.priorityRequestId : ''
    const self = await decidePriority(w.pa.rc(win.clock), { priorityRequestId: rid, decision: 'approve' })
    expect(self.ok).toBe(false)
    if (!self.ok) expect(self.code).toBe('separation_of_duties')
    expect((await entryRow(own.ok ? own.data.entryId : '')).priority).toBeNull()
    // the Accommodation Admin has no exception authority
    const byAa = await decidePriority(w.aa.rc(win.clock), { priorityRequestId: rid, decision: 'approve' })
    expect(byAa.ok).toBe(false)
    if (!byAa.ok) expect(byAa.code).toBe('forbidden')
    // a person holding both roles cannot decide what they asked for
    const both = await person('AA', { siteIds: [w.siteId], caps: ['PolicyApprover'] })
    const [x] = await queued(w, win, 1)
    const asked = await requestPriority(both.rc(win.clock), { entryId: x.entryId, category: 'Safety', reason: 'needed', evidence: 'report' })
    const askedId = asked.ok ? asked.data.priorityRequestId : ''
    const sod = await decidePriority(both.rc(win.clock), { priorityRequestId: askedId, decision: 'approve' })
    expect(sod.ok).toBe(false)
    if (!sod.ok) expect(sod.code).toBe('separation_of_duties')
    expect((await decidePriority(w.pa.rc(win.clock), { priorityRequestId: askedId, decision: 'approve' })).ok).toBe(true)
  })

  it('scope: a Policy Approver of another site gets "not found"; a person asking about an entry elsewhere gets "not found"', async () => {
    const a = await world(), b = await world()
    const win = window()
    const [x] = await queued(a, win, 1)
    const asked = await requestPriority(a.aa.rc(win.clock), { entryId: x.entryId, category: 'Medical', reason: 'needed', evidence: 'letter' })
    const id = asked.ok ? asked.data.priorityRequestId : ''
    const out = await decidePriority(b.pa.rc(win.clock), { priorityRequestId: id, decision: 'approve' })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.code).toBe('not_found')
    const elsewhere = await requestPriority(b.aa.rc(win.clock), { entryId: x.entryId, category: 'Medical', reason: 'needed', evidence: 'letter' })
    expect(elsewhere.ok).toBe(false)
    if (!elsewhere.ok) expect(elsewhere.code).toBe('not_found')
  })

  it('the named backup may decide only once the item is routed to them (after the SLA), never before', async () => {
    const w = await world()
    const win = window()
    const backup = await person('Rec', { siteIds: [w.siteId], caps: ['BackupApprover'] })
    const [x] = await queued(w, win, 1)
    const asked = await requestPriority(w.aa.rc(win.clock), { entryId: x.entryId, category: 'Safety', reason: 'needed', evidence: 'report' })
    const id = asked.ok ? asked.data.priorityRequestId : ''
    win.clock.advance(25 * 3600_000) // Tuesday: one business day, still the Policy Approver's
    const early = await decidePriority(backup.rc(win.clock), { priorityRequestId: id, decision: 'approve' })
    expect(early.ok).toBe(false)
    if (!early.ok) expect((early.detail as any).reason).toBe('not_yet_routed')
    win.clock.advance(24 * 3600_000) // Wednesday: two business days, routed to the backup
    expect((await decidePriority(backup.rc(win.clock), { priorityRequestId: id, decision: 'approve' })).ok).toBe(true)
    expect((await entryRow(x.entryId)).priority).toBe('Safety')
  })

  it('through the API: the Accommodation Admin asks, the Policy Approver decides; Reception cannot ask, the Accommodation Admin cannot decide', async () => {
    const w = await world()
    const win = window()
    setClock(win.clock)
    const [x] = await queued(w, win, 1)
    const aa = await cookieOf(w.aa), pa = await cookieOf(w.pa), rec = await cookieOf(w.rec)
    const body = { category: 'Medical', reason: 'needs ground floor', evidence: 'letter' }
    expect((await call(requestRoute, { cookie: rec, body, params: { id: x.entryId } })).status).toBe(403)
    const asked = await call(requestRoute, { cookie: aa, body, params: { id: x.entryId } })
    expect(asked.status).toBe(200)
    const id = asked.body.data.priorityRequestId
    expect((await call(decideRoute, { cookie: aa, body: { decision: 'approve' }, params: { id } })).status).toBe(403)
    expect((await call(decideRoute, { cookie: pa, body: { decision: 'approve' }, params: { id } })).status).toBe(200)
    expect((await entryRow(x.entryId)).priority).toBe('Medical')
  })
})
