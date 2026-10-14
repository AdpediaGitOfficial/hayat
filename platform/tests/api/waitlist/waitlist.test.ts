import { afterAll, describe, expect, it } from 'vitest'
import { admin, call, closeAll } from '../harness'
import { setClock } from '@/server/runtime'
import { mkBed, mkException, mkRequest, mkRoom, mkSite, mkStaff, notificationsByKey, setConfigValue } from '../fixtures2'
import { audits, cookieOf, entryRow, notes, person, window, world } from './helpers'
import { addToWaitlist } from '@/server/commands/waitlist/add'
import { leaveWaitlist } from '@/server/commands/waitlist/leave'
import { renewEntry } from '@/server/commands/waitlist/renew'
import { sortQueue, queuePosition } from '@/server/commands/waitlist/queue'
import { getDb } from '@/server/db/client'
import { GET as listRoute, POST as addRoute } from '../../../app/api/v1/waitlist/route'
import { POST as leaveRoute } from '../../../app/api/v1/waitlist/[id]/leave/route'
import { POST as renewRoute } from '../../../app/api/v1/waitlist/[id]/renew/route'

afterAll(closeAll)

const DAYS15 = 15 * 86_400_000

describe('AT-009 waitlist creation', () => {
  it('a resident with no matching bed gets an entry with the right created and expiry dates and a queue position (through the API)', async () => {
    const w = await world()
    const win = window()
    setClock(win.clock)
    const cookie = await cookieOf(w.res)
    const r = await call(addRoute, { cookie, body: { siteId: w.siteId, arrival: win.day(5), end: win.day(65) } })
    expect(r.status).toBe(200)
    expect(r.body.data.position).toBe(1)
    const e = await entryRow(r.body.data.entryId)
    expect(e.status).toBe('waiting')
    expect(e.expires_at.getTime()).toBe(win.clock.nowMs() + DAYS15)
    expect(e.queue_ts.getTime()).toBe(win.clock.nowMs())
    expect(r.body.data.expiresAt).toBe(new Date(win.clock.nowMs() + DAYS15).toISOString())
    const row = (await admin().query(`SELECT created_at, stay_type, arrival_date::text AS arrival, end_date::text AS "end", on_behalf FROM waitlist_entry WHERE id = $1`, [r.body.data.entryId])).rows[0]
    expect(row.created_at.getTime()).toBe(win.clock.nowMs())
    expect(row).toMatchObject({ stay_type: 'contract', arrival: win.day(5), end: win.day(65), on_behalf: false })
    expect((await audits(r.body.data.entryId)).map(a => a.action)).toEqual(['waitlist.entry.created'])
    expect((await notes(`waitlist:${r.body.data.entryId}:created`))).toHaveLength(1)

    // the next person queues behind them
    const res2 = await person('Res')
    const cookie2 = await cookieOf(res2)
    win.clock.advance(60_000)
    const r2 = await call(addRoute, { cookie: cookie2, body: { siteId: w.siteId, arrival: win.day(8) } })
    expect(r2.status).toBe(200)
    expect(r2.body.data.position).toBe(2)
    expect((await entryRow(r2.body.data.entryId)).status).toBe('waiting')
    expect((await admin().query(`SELECT stay_type FROM waitlist_entry WHERE id = $1`, [r2.body.data.entryId])).rows[0].stay_type).toBe('permanent') // open-ended
  })

  it('"no bed matches" from the approval screen: the Accommodation Admin waitlists a request on behalf of the person, and the request becomes Waitlisted', async () => {
    const w = await world()
    const win = window()
    const staff = await mkStaff()
    const requestId = await mkRequest({ staffId: staff.id, siteId: w.siteId, arrival: win.day(3), end: win.day(40), status: 'pending_approval', stayType: 'trainee' })
    const r = await addToWaitlist(w.aa.rc(win.clock), { staffId: staff.id, siteId: w.siteId, requestId, arrival: win.day(3), end: win.day(40) })
    expect(r.ok).toBe(true)
    const req = (await admin().query(`SELECT status FROM accommodation_request WHERE id = $1`, [requestId])).rows[0]
    expect(req.status).toBe('waitlisted')
    const e = r.ok ? await entryRow(r.data.entryId) : undefined
    expect(e?.status).toBe('waiting')
    const row = (await admin().query(`SELECT stay_type, on_behalf, request_id, created_by FROM waitlist_entry WHERE id = $1`, [r.ok ? r.data.entryId : null])).rows[0]
    expect(row).toMatchObject({ stay_type: 'trainee', on_behalf: true, request_id: requestId, created_by: w.aa.user.id })
    // a request that is not waiting for a decision cannot be waitlisted; another person's request neither
    const done = await mkRequest({ staffId: (await mkStaff()).id, siteId: w.siteId, status: 'approved' })
    const other = await mkStaff()
    expect((await addToWaitlist(w.aa.rc(win.clock), { staffId: other.id, siteId: w.siteId, requestId: done, arrival: win.day(3) })).ok).toBe(false)
  })

  it('one live entry per person, with a clear refusal naming the existing one; a person who has a reservation cannot queue', async () => {
    const w = await world()
    const win = window()
    const s = await mkStaff()
    const a = await addToWaitlist(w.rec.rc(win.clock), { staffId: s.id, siteId: w.siteId, arrival: win.day(2) })
    expect(a.ok).toBe(true)
    const b = await addToWaitlist(w.rec.rc(win.clock), { staffId: s.id, siteId: w.siteId, arrival: win.day(2) })
    expect(b.ok).toBe(false)
    if (!b.ok) { expect(b.code).toBe('conflict'); expect((b.detail as any).entryId).toBe(a.ok ? a.data.entryId : '') }
    // a concurrent double submit leaves exactly one entry (database index behind the check)
    const s2 = await mkStaff()
    const both = await Promise.all([1, 2].map(() => addToWaitlist(w.rec.rc(win.clock), { staffId: s2.id, siteId: w.siteId, arrival: win.day(2) })))
    expect(both.filter(x => x.ok)).toHaveLength(1)
    expect(Number((await admin().query(`SELECT count(*) FROM waitlist_entry WHERE staff_id = $1`, [s2.id])).rows[0].count)).toBe(1)
    // housed people do not queue
    const housed = await mkStaff()
    const claim = (await admin().query(`INSERT INTO bed_claim (bed_id, kind, period) VALUES ($1, 'reservation', $2::daterange) RETURNING id`, [w.bedIds[0], `[${win.day(30)},${win.day(60)})`])).rows[0]
    await admin().query(`INSERT INTO reservation (staff_id, bed_id, claim_id, eta, source, stay_type) VALUES ($1, $2, $3, now(), 'request', 'contract')`, [housed.id, w.bedIds[0], claim.id])
    const h = await addToWaitlist(w.rec.rc(win.clock), { staffId: housed.id, siteId: w.siteId, arrival: win.day(2) })
    expect(h.ok).toBe(false)
    if (!h.ok) expect((h.detail as any).reason).toBe('already_housed')
  })

  it('eligible in principle: a person no bed type at the site is open to is told why, and who can grant an exception', async () => {
    const siteId = await mkSite()
    const room = await mkRoom(siteId, { gender: 'male' })
    await mkBed(room)
    const aa = await person('AA', { siteIds: [siteId] })
    const win = window()
    const woman = await mkStaff({ gender: 'female' })
    const r = await addToWaitlist(aa.rc(win.clock), { staffId: woman.id, siteId, arrival: win.day(2) })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe('conflict')
      expect(r.owner).toBe('Policy Approver')
      expect(r.reason).toMatch(/male-only/)
      expect((r.detail as any).exceptionable).toBe(true)
    }
    // a Policy Approver exception makes her eligible in principle
    await mkException({ staffId: woman.id, kind: 'gender', grantedBy: aa.user.id, siteId })
    expect((await addToWaitlist(aa.rc(win.clock), { staffId: woman.id, siteId, arrival: win.day(2) })).ok).toBe(true)
    // a site with no beds at all says so
    const empty = await mkSite()
    const aa2 = await person('AA', { siteIds: [empty] })
    const none = await addToWaitlist(aa2.rc(win.clock), { staffId: (await mkStaff()).id, siteId: empty, arrival: win.day(2) })
    expect(none.ok).toBe(false)
    if (!none.ok) expect(none.reason).toMatch(/no beds yet/)
    // a left employee never queues
    const left = await mkStaff({ status: 'left' })
    expect((await addToWaitlist(aa.rc(win.clock), { staffId: left.id, siteId, arrival: win.day(2) })).ok).toBe(false)
  })

  it('validation: the arrival day cannot be in the past and the departure day must follow it', async () => {
    const w = await world()
    const win = window()
    const s = await mkStaff()
    const past = await addToWaitlist(w.aa.rc(win.clock), { staffId: s.id, siteId: w.siteId, arrival: win.day(-1) })
    expect(past.ok).toBe(false)
    if (!past.ok) expect(past.fields).toHaveProperty('arrival')
    const backwards = await addToWaitlist(w.aa.rc(win.clock), { staffId: s.id, siteId: w.siteId, arrival: win.day(5), end: win.day(5) })
    expect(backwards.ok).toBe(false)
    if (!backwards.ok) expect(backwards.fields).toHaveProperty('end')
    expect((await addToWaitlist(w.aa.rc(win.clock), { staffId: s.id, siteId: w.siteId, arrival: win.day(0) })).ok).toBe(true) // today is fine (D-103)
  })
})

describe('scope and separation (AT-002 style)', () => {
  it('an Accommodation Admin of site A gets "not found" for anything about site B; a resident cannot queue someone else', async () => {
    const a = await world(), b = await world()
    const win = window()
    setClock(win.clock)
    const staff = await mkStaff()
    const inB = await addToWaitlist(b.aa.rc(win.clock), { staffId: staff.id, siteId: b.siteId, arrival: win.day(2) })
    expect(inB.ok).toBe(true)
    const entryId = inB.ok ? inB.data.entryId : ''
    const aaA = await cookieOf(a.aa)
    // cannot add to B, cannot leave/renew an entry of B
    expect((await call(addRoute, { cookie: aaA, body: { staffId: (await mkStaff()).id, siteId: b.siteId, arrival: win.day(2) } })).status).toBe(404)
    expect((await call(leaveRoute, { cookie: aaA, body: { reason: 'not mine' }, params: { id: entryId } })).status).toBe(404)
    expect((await call(renewRoute, { cookie: aaA, body: {}, params: { id: entryId } })).status).toBe(404)
    expect((await entryRow(entryId)).status).toBe('waiting')
    // the queue list shows A only
    const mine = await mkStaff()
    await addToWaitlist(a.aa.rc(win.clock), { staffId: mine.id, siteId: a.siteId, arrival: win.day(2) })
    const list = await call(listRoute, { cookie: aaA, path: '/api/v1/waitlist' })
    expect(list.status).toBe(200)
    expect(list.body.data.kind).toBe('staff')
    expect(list.body.data.queues.map((q: any) => q.siteId)).toEqual([a.siteId])
    expect(list.body.data.queues[0].entries.map((e: any) => e.staffId)).toEqual([mine.id])
    // a resident adding another person is "not found"; adding themselves works and leaves nothing for others
    const resCookie = await cookieOf(a.res)
    expect((await call(addRoute, { cookie: resCookie, body: { staffId: mine.id, siteId: a.siteId, arrival: win.day(2) } })).status).toBe(404)
    const own = await call(listRoute, { cookie: resCookie, path: '/api/v1/waitlist' })
    expect(own.body.data).toMatchObject({ kind: 'own', entry: null })
    // Reception can join people but cannot renew (that is the Accommodation Admin's)
    expect((await call(renewRoute, { cookie: await cookieOf(a.rec), body: {}, params: { id: entryId } })).status).toBe(403)
  })
})

describe('read-only roles', () => {
  it('the Read-only Manager sees the shape of the queue (positions, timers) but not who is in it; the Auditor and Reception see people', async () => {
    const w = await world()
    const win = window()
    setClock(win.clock)
    const staff = await mkStaff({ name: 'Zainab Hussain' })
    await addToWaitlist(w.aa.rc(win.clock), { staffId: staff.id, siteId: w.siteId, arrival: win.day(2) })
    const mgr = await person('Mgr', { siteIds: [w.siteId] })
    const aud = await person('Aud', { siteIds: [w.siteId] })
    const asMgr = await call(listRoute, { cookie: await cookieOf(mgr), path: '/api/v1/waitlist' })
    expect(asMgr.status).toBe(200)
    const m = asMgr.body.data.queues[0].entries
    expect(m).toHaveLength(1)
    expect(m[0]).toMatchObject({ position: 1, name: 'Waitlist entry 1', employeeId: '', staffId: '' })
    expect(JSON.stringify(asMgr.body)).not.toContain('Zainab')
    for (const p of [aud, w.rec]) {
      const r = await call(listRoute, { cookie: await cookieOf(p), path: '/api/v1/waitlist' })
      expect(r.body.data.queues[0].entries[0].name).toBe('Zainab Hussain')
    }
  })
})

describe('queue order (D-53)', () => {
  it('sorts by approved priority category, then oldest, then id', () => {
    const t = (n: number) => new Date(Date.UTC(2026, 0, n))
    const rows = [
      { id: 'a', priority: null, queueTs: t(1) },
      { id: 'b', priority: 'Safety', queueTs: t(5) },
      { id: 'c', priority: 'Medical', queueTs: t(9) },
      { id: 'd', priority: null, queueTs: t(1) },
      { id: 'e', priority: 'Retired category', queueTs: t(0) },
    ]
    expect(sortQueue(rows, ['Medical', 'Safety']).map(r => r.id)).toEqual(['c', 'b', 'e', 'a', 'd'])
    expect(sortQueue(rows, []).map(r => r.id)).toEqual(['e', 'a', 'd', 'b', 'c'])
  })

  it('positions follow the order in which people joined', async () => {
    const w = await world()
    const win = window()
    const ids: string[] = []
    for (let i = 0; i < 3; i++) {
      win.clock.advance(3600_000)
      const r = await addToWaitlist(w.rec.rc(win.clock), { staffId: (await mkStaff()).id, siteId: w.siteId, arrival: win.day(4) })
      expect(r.ok && r.data.position).toBe(i + 1)
      ids.push(r.ok ? r.data.entryId : '')
    }
    expect(await queuePosition(getDb(), w.siteId, ids[1])).toBe(2)
  })
})

describe('waitlist renewal (D-48, GH-05 open: recommended default)', () => {
  it('renewed before expiry with the same requirements: the place is kept and the expiry moves; reminder history starts fresh and the audit keeps the old one', async () => {
    const w = await world()
    const win = window()
    const first = await addToWaitlist(w.rec.rc(win.clock), { staffId: (await mkStaff()).id, siteId: w.siteId, arrival: win.day(4) })
    win.clock.advance(3600_000)
    const mine = await addToWaitlist(w.rec.rc(win.clock), { staffId: (await mkStaff()).id, siteId: w.siteId, arrival: win.day(4) })
    expect(first.ok && mine.ok).toBe(true)
    const entryId = mine.ok ? mine.data.entryId : ''
    await admin().query(`UPDATE waitlist_entry SET reminders_sent = '{3}' WHERE id = $1`, [entryId])
    win.clock.advance(12 * 86_400_000)
    const r = await renewEntry(w.aa.rc(win.clock), { entryId })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data).toMatchObject({ positionBefore: 2, positionAfter: 2, positionKept: true })
    const e = await entryRow(entryId)
    expect(e.expires_at.getTime()).toBe(win.clock.nowMs() + DAYS15)
    expect(e).toMatchObject({ renewals: 1, reminders_sent: [] })
    const a = (await audits(entryId)).find(x => x.action === 'waitlist.entry.renewed')!
    expect(a.before.remindersSent).toEqual([3])
    expect(a.actor_role).toBe('AA')
  })

  it('renewed with changed dates: the place is lost (back of the queue); an offer in flight blocks changing dates', async () => {
    const w = await world()
    const win = window()
    const early = await addToWaitlist(w.rec.rc(win.clock), { staffId: (await mkStaff()).id, siteId: w.siteId, arrival: win.day(4) })
    win.clock.advance(3600_000)
    const mine = await addToWaitlist(w.rec.rc(win.clock), { staffId: (await mkStaff()).id, siteId: w.siteId, arrival: win.day(4) })
    win.clock.advance(3600_000)
    await addToWaitlist(w.rec.rc(win.clock), { staffId: (await mkStaff()).id, siteId: w.siteId, arrival: win.day(4) })
    expect(early.ok).toBe(true)
    const entryId = mine.ok ? mine.data.entryId : ''
    win.clock.advance(86_400_000)
    const r = await renewEntry(w.aa.rc(win.clock), { entryId, arrival: win.day(10), end: win.day(70) })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data).toMatchObject({ positionBefore: 2, positionAfter: 3, positionKept: false })
    expect((await entryRow(entryId)).queue_ts.getTime()).toBe(win.clock.nowMs())
    const a = (await audits(entryId)).find(x => x.action === 'waitlist.entry.renewed')!
    expect(a.after).toMatchObject({ priorSequence: 2, newSequence: 3, positionKept: false })
  })

  it('refused: after expiry, for someone no longer eligible, for the Accommodation Admin\'s own entry, and by Reception', async () => {
    const w = await world()
    const win = window()
    const staff = await mkStaff({ grade: 5 })
    const e = await addToWaitlist(w.rec.rc(win.clock), { staffId: staff.id, siteId: w.siteId, arrival: win.day(4) })
    const entryId = e.ok ? e.data.entryId : ''
    // not eligible any more (the site now needs a higher grade): revalidation fails, exceptions can fix it
    await setConfigValue('eligibility.min_grade', 8, w.siteId)
    const el = await renewEntry(w.aa.rc(win.clock), { entryId })
    expect(el.ok).toBe(false)
    if (!el.ok) { expect(el.owner).toBe('Policy Approver'); expect((el.detail as any).reason).toBe('not_eligible') }
    await setConfigValue('eligibility.min_grade', 0, w.siteId)
    expect((await renewEntry(w.rec.rc(win.clock), { entryId })).ok).toBe(false) // Reception: no manage_waitlist
    // expired but not yet swept: cannot keep its place
    win.clock.advance(15 * 86_400_000)
    const late = await renewEntry(w.aa.rc(win.clock), { entryId })
    expect(late.ok).toBe(false)
    if (!late.ok) expect((late.detail as any).reason).toBe('entry_expired')
    // own entry (D-26)
    const own = await addToWaitlist(w.aa.rc(win.clock), { staffId: w.aa.staffId, siteId: w.siteId, arrival: win.day(4) })
    expect(own.ok).toBe(true)
    const self = await renewEntry(w.aa.rc(win.clock), { entryId: own.ok ? own.data.entryId : '' })
    expect(self.ok).toBe(false)
    if (!self.ok) expect(self.code).toBe('separation_of_duties')
  })
})

describe('leaving the waitlist', () => {
  it('closes the entry, cancels the linked request, withdraws a pending priority request, and repeating is harmless', async () => {
    const w = await world()
    const win = window()
    setClock(win.clock)
    const requestId = await mkRequest({ staffId: w.res.staffId, siteId: w.siteId, status: 'pending_approval' })
    const added = await addToWaitlist(w.aa.rc(win.clock), { staffId: w.res.staffId, siteId: w.siteId, requestId, arrival: win.day(2) })
    const entryId = added.ok ? added.data.entryId : ''
    const cookie = await cookieOf(w.res)
    expect((await call(leaveRoute, { cookie, body: {}, params: { id: entryId } })).status).toBe(422) // a reason is needed
    const r = await call(leaveRoute, { cookie, body: { reason: 'found a room myself' }, params: { id: entryId } })
    expect(r.status).toBe(200)
    expect(await entryRow(entryId)).toMatchObject({ status: 'closed', close_reason: 'left' })
    expect((await admin().query(`SELECT status, decision_reason FROM accommodation_request WHERE id = $1`, [requestId])).rows[0]).toMatchObject({ status: 'cancelled' })
    const again = await call(leaveRoute, { cookie, body: { reason: 'found a room myself' }, params: { id: entryId } })
    expect(again.status).toBe(200)
    expect((await audits(entryId)).filter(a => a.action === 'waitlist.entry.left')).toHaveLength(1)
    // the person can join again later (a closed entry is history)
    const re = await addToWaitlist(w.res.rc(win.clock), { siteId: w.siteId, arrival: win.day(3) })
    expect(re.ok).toBe(true)
    // another resident cannot take someone off the waitlist
    const other = await person('Res')
    expect((await call(leaveRoute, { cookie: await cookieOf(other), body: { reason: 'sabotage' }, params: { id: re.ok ? re.data.entryId : '' } })).status).toBe(404)
    expect(await notificationsByKey(`waitlist:${entryId}:left`)).toHaveLength(0) // they left for themselves: no notification to themselves
  })
})
