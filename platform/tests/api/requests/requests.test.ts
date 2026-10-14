import { afterAll, describe, expect, it } from 'vitest'
import { admin, call, closeAll } from '../harness'
import { mkSite, occupy, reserve } from '../fixtures2'
import { FixedClock } from '@/server/clock'
import { auditActions, count, day, mkProperty, mkRequest, mkStaff, must, notifCount, requestRow, scenario, who } from './helpers'
import { submitRequest } from '@/server/commands/requests/submit'
import { editRequest, resubmitRequest } from '@/server/commands/requests/edit'
import { cancelRequest } from '@/server/commands/requests/cancel'
import { rejectRequest, requestChanges } from '@/server/commands/requests/decide'
import { approveRequest } from '@/server/commands/requests/approve'
import { listRequests } from '@/server/queries/requests/list'
import { getRequestDetail } from '@/server/queries/requests/detail'
import { getDb } from '@/server/db/client'
import { POST as rejectRoute } from '../../../app/api/v1/requests/[id]/reject/route'
import { POST as cancelRoute } from '../../../app/api/v1/requests/[id]/cancel/route'
import { POST as submitRoute } from '../../../app/api/v1/requests/route'
import { GET as detailRoute } from '../../../app/api/v1/requests/[id]/route'

afterAll(closeAll)

const base = (siteId: string, extra: Record<string, unknown> = {}) => ({ siteId, arrivalDate: day(5), endDate: day(35), stayType: 'contract' as const, note: null, ...extra })

describe('submitting a request', () => {
  it('a Resident files for themselves at ANY live site; the admin of that site is notified once', async () => {
    const p = await mkProperty()
    const res = await who('Res')
    const r = must(await submitRequest(res.rc, base(p.siteId)))
    expect(r.status).toBe('submitted')
    expect(r.onBehalf).toBe(false)
    const row = await requestRow(r.requestId)
    expect(row.staff_id).toBe(res.staffId)
    expect(row.status).toBe('submitted')
    expect(row.submitted_by).toBe(res.user.id)
    expect(await auditActions(r.requestId)).toEqual(['requests.request.submitted'])
    expect(await notifCount(`request:${r.requestId}:submitted%`)).toBe(1)
  })

  it('Reception and AA file on behalf, only at their own sites; the person is told; on_behalf and submitted_by are recorded', async () => {
    const p = await mkProperty()
    const other = await mkSite()
    const rec = await who('Rec', { siteIds: [p.siteId] })
    const person = await mkStaff()
    const r = must(await submitRequest(rec.rc, base(p.siteId, { staffId: person.id })))
    expect(r.onBehalf).toBe(true)
    const row = await requestRow(r.requestId)
    expect(row).toMatchObject({ staff_id: person.id, on_behalf: true, submitted_by: rec.user.id })
    expect(await notifCount(`request:${r.requestId}:submitted:resident`)).toBe(1)

    const elsewhere = await submitRequest(rec.rc, base(other, { staffId: (await mkStaff()).id }))
    expect(elsewhere.ok).toBe(false)
    if (!elsewhere.ok) { expect(elsewhere.code).toBe('invalid'); expect(elsewhere.fields?.siteId).toBeTruthy() }
  })

  it('by employee ID, and a Resident can never file for somebody else (403, and nothing is revealed about the other person)', async () => {
    const p = await mkProperty()
    const rec = await who('Rec', { siteIds: [p.siteId] })
    const person = await mkStaff()
    expect(must(await submitRequest(rec.rc, base(p.siteId, { employeeId: person.employeeId.toUpperCase() }))).onBehalf).toBe(true)
    const miss = await submitRequest(rec.rc, base(p.siteId, { employeeId: 'NOPE-0000' }))
    expect(miss.ok).toBe(false)
    if (!miss.ok) expect(miss.fields?.employeeId).toBeTruthy()

    const res = await who('Res')
    const other = await mkStaff()
    for (const i of [{ staffId: other.id }, { employeeId: other.employeeId }, { employeeId: 'NOPE-0000' }]) {
      const r = await submitRequest(res.rc, base(p.siteId, i))
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.code).toBe('forbidden')
    }
  })

  it('D-103 dates: arrival not in the past, the departure day must be AFTER arrival, open-ended only for permanent', async () => {
    const p = await mkProperty()
    const res = await who('Res')
    const bad = async (extra: Record<string, unknown>, field: string) => {
      const r = await submitRequest(res.rc, base(p.siteId, extra))
      expect(r.ok, JSON.stringify(extra)).toBe(false)
      if (!r.ok) { expect(r.code).toBe('invalid'); expect(r.fields?.[field]).toBeTruthy() }
    }
    await bad({ arrivalDate: day(-1) }, 'arrivalDate')
    await bad({ endDate: day(5) }, 'endDate') // departure on the arrival day: no night at all
    await bad({ endDate: day(4) }, 'endDate')
    await bad({ endDate: null, stayType: 'contract' }, 'endDate')
    await bad({ endDate: null, stayType: 'trainee' }, 'endDate')
    expect(must(await submitRequest(res.rc, base(p.siteId, { arrivalDate: day(0), endDate: day(1) }))).status).toBe('submitted') // today is fine, one night is fine
    const perm = await who('Res')
    expect(must(await submitRequest(perm.rc, base(p.siteId, { endDate: null, stayType: 'permanent' }))).status).toBe('submitted')
  })

  it('arrival is checked against the SITE\'s today (time zone), not the server\'s', async () => {
    const siteId = await mkSite({ tz: 'Pacific/Kiritimati' }) // UTC+14: at 12:00 UTC on 14 October it is already 15 October there
    const res = await who('Res', { clock: new FixedClock(Date.UTC(2026, 9, 14, 12)) })
    const r = await submitRequest(res.rc, base(siteId, { arrivalDate: '2026-10-14', endDate: '2026-10-20' }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.fields?.arrivalDate).toMatch(/2026-10-15/)
  })

  it('one open request per person: the second is refused naming the first, also under a simultaneous double submit', async () => {
    const p = await mkProperty()
    const res = await who('Res')
    const first = must(await submitRequest(res.rc, base(p.siteId)))
    const again = await submitRequest(res.rc, base(p.siteId))
    expect(again.ok).toBe(false)
    if (!again.ok) { expect(again.code).toBe('conflict'); expect((again.detail as any).requestId).toBe(first.requestId); expect(again.next).toBeTruthy() }

    const res2 = await who('Res')
    const both = await Promise.all([submitRequest(res2.rc, base(p.siteId)), submitRequest(res2.rc, base(p.siteId))])
    expect(both.filter(r => r.ok)).toHaveLength(1)
    expect(await count(`SELECT count(*) FROM accommodation_request WHERE staff_id = $1`, [res2.staffId])).toBe(1)
  })

  it('refuses a person who has left, an archived site, someone already housed, reserved or queued', async () => {
    const p = await mkProperty()
    const aa = await who('AA', { siteIds: [p.siteId] })
    const left = await mkStaff({ status: 'left' })
    const r1 = await submitRequest(aa.rc, base(p.siteId, { staffId: left.id }))
    expect(r1.ok).toBe(false)
    if (!r1.ok) expect((r1.detail as any).reason).toBe('not_active')

    const archived = await mkSite()
    await admin().query(`UPDATE site SET archived_at = now() WHERE id = $1`, [archived])
    const res = await who('Res')
    const r2 = await submitRequest(res.rc, base(archived))
    expect(r2.ok).toBe(false)
    if (!r2.ok) expect(r2.fields?.siteId).toBeTruthy()

    const housed = await occupy(p.bedIds[0], '2026-10-01')
    const r3 = await submitRequest(aa.rc, base(p.siteId, { staffId: housed.staffId }))
    expect(r3.ok).toBe(false)
    if (!r3.ok) expect((r3.detail as any).reason).toBe('has_stay')
    const booked = await reserve(p.bedIds[1], day(3), day(9))
    const r4 = await submitRequest(aa.rc, base(p.siteId, { staffId: booked.staffId }))
    expect(r4.ok).toBe(false)
    if (!r4.ok) expect((r4.detail as any).reason).toBe('has_reservation')
    const queued = await mkStaff()
    await admin().query(`INSERT INTO waitlist_entry (staff_id, site_id, arrival_date, stay_type, expires_at) VALUES ($1, $2, current_date + 10, 'contract', now() + interval '15 days')`, [queued.id, p.siteId])
    const r5 = await submitRequest(aa.rc, base(p.siteId, { staffId: queued.id }))
    expect(r5.ok).toBe(false)
    if (!r5.ok) expect((r5.detail as any).reason).toBe('on_waitlist')
  })
})

describe('sending back, editing, resubmitting, cancelling, rejecting', () => {
  it('changes requested -> the requester edits (even the site) -> resubmits; every step audited, each notification once', async () => {
    const s = await scenario()
    const res = await who('Res')
    const { requestId } = must(await submitRequest(res.rc, base(s.siteId)))
    must(await requestChanges(s.aa.rc, { requestId, reason: 'Please give the real departure date' }))
    expect((await requestRow(requestId)).status).toBe('changes_requested')
    expect(await notifCount(`request:${requestId}:changes:%`)).toBe(1)

    // still waiting for the requester: the admin can not approve it now
    const early = await approveRequest(s.aa.rc, { requestId, bedId: s.bedIds[0] })
    expect(early.ok).toBe(false)
    if (!early.ok) { expect(early.code).toBe('conflict'); expect(early.owner).toBe('The requester') }

    const other = await mkSite()
    const edited = must(await editRequest(res.rc, { requestId, siteId: other, endDate: day(60) }))
    expect(edited.status).toBe('changes_requested') // saved, not yet sent back
    const sent = must(await resubmitRequest(res.rc, { requestId }))
    expect(sent.status).toBe('submitted')
    const row = await requestRow(requestId)
    expect(row).toMatchObject({ site_id: other, status: 'submitted' })
    expect(await auditActions(requestId)).toEqual(['requests.request.submitted', 'requests.request.changes_requested', 'requests.request.edited', 'requests.request.resubmitted'])
    expect(await notifCount(`request:${requestId}:resubmitted:%`)).toBe(1)
    // a retried resubmit changes nothing
    expect(must(await resubmitRequest(res.rc, { requestId })).status).toBe('submitted')
    expect(await notifCount(`request:${requestId}:resubmitted:%`)).toBe(1)
  })

  it('editing is for the requester only, and only while the request is sent back', async () => {
    const s = await scenario()
    const res = await who('Res')
    const { requestId } = must(await submitRequest(res.rc, base(s.siteId)))
    const underReview = await editRequest(res.rc, { requestId, endDate: day(50) })
    expect(underReview.ok).toBe(false)
    if (!underReview.ok) expect(underReview.code).toBe('conflict')
    must(await requestChanges(s.aa.rc, { requestId, reason: 'Change the dates' }))
    const stranger = await who('Res')
    const e = await editRequest(stranger.rc, { requestId, endDate: day(50) })
    expect(e.ok).toBe(false)
    if (!e.ok) expect(e.code).toBe('not_found') // not theirs: indistinguishable from "does not exist"
    const adminEdit = await editRequest(s.aa.rc, { requestId, endDate: day(50) })
    expect(adminEdit.ok).toBe(false)
    if (!adminEdit.ok) expect(adminEdit.code).toBe('forbidden')
  })

  it('resubmit checks the dates again: an arrival that has passed must be changed first', async () => {
    const s = await scenario()
    const res = await who('Res')
    const { requestId } = must(await submitRequest(res.rc, base(s.siteId)))
    must(await requestChanges(s.aa.rc, { requestId, reason: 'Check' }))
    await admin().query(`UPDATE accommodation_request SET arrival_date = $2, end_date = $3 WHERE id = $1`, [requestId, day(-3), day(9)])
    const r = await resubmitRequest(res.rc, { requestId })
    expect(r.ok).toBe(false)
    if (!r.ok) { expect(r.code).toBe('invalid'); expect(r.fields?.arrivalDate).toBeTruthy() }
  })

  it('cancel: the requester, the officer who filed it or an admin of the site; with a reason; never after approval; others see "not found"', async () => {
    const s = await scenario()
    const res = await who('Res')
    const a = must(await submitRequest(res.rc, base(s.siteId)))
    const stranger = await who('Res')
    const nope = await cancelRequest(stranger.rc, { requestId: a.requestId, reason: 'not mine' })
    expect(nope.ok).toBe(false)
    if (!nope.ok) expect(nope.code).toBe('not_found')
    const outsider = await who('AA', { siteIds: [await mkSite()] })
    const out = await cancelRequest(outsider.rc, { requestId: a.requestId, reason: 'not mine' })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.code).toBe('not_found')

    must(await cancelRequest(res.rc, { requestId: a.requestId, reason: 'Plans changed' }))
    expect((await requestRow(a.requestId))).toMatchObject({ status: 'cancelled', decision_reason: 'Plans changed' })
    expect(must(await cancelRequest(res.rc, { requestId: a.requestId, reason: 'Plans changed' })).status).toBe('cancelled') // retry
    const again = await cancelRequest(s.aa.rc, { requestId: a.requestId, reason: 'x again' })
    expect(again.ok).toBe(false)

    const rec = await who('Rec', { siteIds: [s.siteId] })
    const person = await mkStaff()
    const b = must(await submitRequest(rec.rc, base(s.siteId, { staffId: person.id })))
    must(await cancelRequest(rec.rc, { requestId: b.requestId, reason: 'Filed by mistake' })) // the officer who filed it
    expect(await notifCount(`request:${b.requestId}:cancelled:resident`)).toBe(1) // the person is told

    const person2 = await mkStaff()
    const c = must(await submitRequest(rec.rc, base(s.siteId, { staffId: person2.id })))
    must(await cancelRequest(s.aa.rc, { requestId: c.requestId, reason: 'Duplicate' })) // an admin of the site
    const approved = await mkStaff()
    const d = await mkRequest({ staffId: approved.id, siteId: s.siteId, arrival: day(10), end: day(20) })
    must(await approveRequest(s.aa.rc, { requestId: d, bedId: s.bedIds[0] }))
    const late = await cancelRequest(s.aa.rc, { requestId: d, reason: 'too late' })
    expect(late.ok).toBe(false)
    if (!late.ok) expect(late.next).toMatch(/reservation/i)
  })

  it('reject needs a reason (422 over the API), tells the resident, and is final', async () => {
    const s = await scenario()
    const res = await who('Res')
    const { requestId } = must(await submitRequest(res.rc, base(s.siteId)))
    const cookie = await s.aa.cookie()
    const none = await call(rejectRoute, { cookie, params: { id: requestId }, body: {} })
    expect(none.status).toBe(422)
    const blank = await call(rejectRoute, { cookie, params: { id: requestId }, body: { reason: '  ' } })
    expect(blank.status).toBe(422)
    expect((await requestRow(requestId)).status).toBe('submitted')

    const ok = await call(rejectRoute, { cookie, params: { id: requestId }, body: { reason: 'No beds for this period' } })
    expect(ok.status).toBe(200)
    expect((await requestRow(requestId))).toMatchObject({ status: 'rejected', decision_reason: 'No beds for this period' })
    expect(await notifCount(`request:${requestId}:rejected:resident`)).toBe(1)
    const retry = must(await rejectRequest(s.aa.rc, { requestId, reason: 'No beds for this period' }))
    expect(retry.status).toBe('rejected')
    expect(await notifCount(`request:${requestId}:rejected:%`)).toBe(1)
    expect((await auditActions(requestId)).filter(a => a === 'requests.request.rejected')).toHaveLength(1)
    const after = await approveRequest(s.aa.rc, { requestId, bedId: s.bedIds[0] })
    expect(after.ok).toBe(false)
  })
})

describe('scope: 403 versus 404, over the API', () => {
  it('an AA of site A gets 404 (never 403) for a site B request; a Resident sees only their own; Reception cannot decide', async () => {
    const a = await mkProperty()
    const b = await mkProperty()
    const aaA = await who('AA', { siteIds: [a.siteId] })
    const res = await who('Res')
    const { requestId } = must(await submitRequest(res.rc, base(b.siteId)))

    const probe = await call(detailRoute, { cookie: await aaA.cookie(), params: { id: requestId } })
    expect(probe.status).toBe(404)
    const reject = await call(rejectRoute, { cookie: await aaA.cookie(), params: { id: requestId }, body: { reason: 'try it' } })
    expect(reject.status).toBe(404)
    expect((await requestRow(requestId)).status).toBe('submitted')

    const stranger = await who('Res')
    expect((await call(detailRoute, { cookie: await stranger.cookie(), params: { id: requestId } })).status).toBe(404)
    expect((await call(detailRoute, { cookie: await res.cookie(), params: { id: requestId } })).status).toBe(200)

    const recB = await who('Rec', { siteIds: [b.siteId] })
    expect((await call(detailRoute, { cookie: await recB.cookie(), params: { id: requestId } })).status).toBe(200) // can see
    const noDecide = await call(rejectRoute, { cookie: await recB.cookie(), params: { id: requestId }, body: { reason: 'try it' } })
    expect(noDecide.status).toBe(403) // role has no such action at all
    const noCancel = await call(cancelRoute, { cookie: await stranger.cookie(), params: { id: requestId }, body: { reason: 'try it' } })
    expect(noCancel.status).toBe(404)
  })

  it('lists are scoped in SQL: an AA sees their sites, a Resident only their own, and a filter cannot widen it', async () => {
    const a = await mkProperty()
    const b = await mkProperty()
    const aaA = await who('AA', { siteIds: [a.siteId] })
    const r1 = await who('Res'); const r2 = await who('Res')
    const ra = must(await submitRequest(r1.rc, base(a.siteId)))
    const rb = must(await submitRequest(r2.rc, base(b.siteId)))
    const seen = async (w: typeof aaA, f: object = {}) => (await listRequests(getDb(), w.rc.actor, f, w.rc.clock.now())).items.map(i => i.id)
    expect(await seen(aaA)).toContain(ra.requestId)
    expect(await seen(aaA)).not.toContain(rb.requestId)
    expect(await seen(aaA, { siteId: b.siteId })).toEqual([])
    expect(await seen(r1)).toEqual([ra.requestId])
    expect(await seen(r1, { siteId: b.siteId })).toEqual([])
    const sa = await who('SA')
    expect(await seen(sa, { status: 'open' })).toEqual(expect.arrayContaining([ra.requestId, rb.requestId]))
  })

  it('the detail shows a Resident their own request without staff names or the exception route; staff see the profile they need', async () => {
    const s = await scenario({ gender: 'female', grade: 4 })
    const res = await who('Res')
    const { requestId } = must(await submitRequest(res.rc, base(s.siteId)))
    must(await requestChanges(s.aa.rc, { requestId, reason: 'Check the dates' }))
    const mine = (await getRequestDetail(getDb(), res.rc, requestId, res.rc.clock.now()))!
    expect(mine.can.edit).toBe(true)
    expect(mine.exception).toBeNull()
    expect(mine.timeline.map(t => t.label)).toEqual(['Request submitted', 'Sent back for changes'])
    expect(mine.timeline.every(t => t.actor === null)).toBe(true)
    const staffView = (await getRequestDetail(getDb(), s.aa.rc, requestId, s.aa.rc.clock.now()))!
    expect(staffView.timeline.every(t => t.actor !== null)).toBe(true)
    // the AA sees gender and grade (they decide eligibility); Reception does not
    const rec = await who('Rec', { siteIds: [s.siteId] })
    const reqId2 = await mkRequest({ staffId: s.person.id, siteId: s.siteId, status: 'submitted' })
    expect((await getRequestDetail(getDb(), s.aa.rc, reqId2, s.aa.rc.clock.now()))!.person).toMatchObject({ gender: 'female', grade: 4 })
    expect((await getRequestDetail(getDb(), rec.rc, reqId2, rec.rc.clock.now()))!.person).toMatchObject({ gender: null, grade: null })
  })
})

describe('the contract with the form', () => {
  it('POST /requests validates the body and answers field errors; a good body is 200 with the new id', async () => {
    const p = await mkProperty()
    const res = await who('Res')
    const cookie = await res.cookie()
    const bad = await call(submitRoute, { cookie, body: { siteId: p.siteId, arrivalDate: 'tomorrow', stayType: 'contract' } })
    expect(bad.status).toBe(422)
    expect(bad.body.fields.arrivalDate).toBeTruthy()
    const good = await call(submitRoute, { cookie, body: base(p.siteId) })
    expect(good.status).toBe(200)
    expect(good.body.data.requestId).toBeTruthy()
  })
})
