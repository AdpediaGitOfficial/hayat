/** What the screens read: the pre-submit check, the sites a person may use, My accommodation, the exception report, the approval clock. */
import { afterAll, describe, expect, it } from 'vitest'
import { admin, call, closeAll } from '../harness'
import { mkRoom, mkBed, mkSite, setConfigValue } from '../fixtures2'
import { day, mkProperty, mkRequest, mkStaff, must, scenario, setStaff, who } from './helpers'
import { requestableSites, requestPreview } from '@/server/queries/requests/preview'
import { myAccommodation } from '@/server/queries/requests/mine'
import { exceptionReportScope, listExceptions } from '@/server/queries/requests/exceptions'
import { approveRequest } from '@/server/commands/requests/approve'
import { grantException, requestException } from '@/server/commands/requests/exceptions'
import { submitRequest } from '@/server/commands/requests/submit'
import { rejectRequest } from '@/server/commands/requests/decide'
import { nextMilestone } from '@/domain/requests'
import { DEFAULT_CALENDAR } from '@/domain/approvals'
import { getDb } from '@/server/db/client'
import { GET as exceptionsRoute } from '../../../app/api/v1/requests/exceptions/route'
import { GET as previewRoute } from '../../../app/api/v1/requests/preview/route'
import { GET as sitesRoute } from '../../../app/api/v1/requests/sites/route'

afterAll(closeAll)

describe('sites a person may file for', () => {
  it('a Resident may choose any live site; Reception and AA only their own; archived sites are never offered', async () => {
    const a = await mkSite({ name: 'Zeta A' }); const b = await mkSite({ name: 'Zeta B' })
    const gone = await mkSite({ name: 'Zeta Gone' })
    await admin().query(`UPDATE site SET archived_at = now() WHERE id = $1`, [gone])
    const res = await who('Res')
    const ids = (await requestableSites(getDb(), res.rc.actor)).map(s => s.id)
    expect(ids).toEqual(expect.arrayContaining([a, b]))
    expect(ids).not.toContain(gone)
    const rec = await who('Rec', { siteIds: [a] })
    expect((await requestableSites(getDb(), rec.rc.actor)).map(s => s.id)).toEqual([a])
    const mgr = await who('Mgr', { siteIds: [a] })
    expect(await requestableSites(getDb(), mgr.rc.actor)).toEqual([]) // a manager files nothing
    const r = await call(sitesRoute, { cookie: await res.cookie() })
    expect(r.status).toBe(200)
  })
})

describe('the check before sending (counts and plain words, nothing about other people)', () => {
  it('counts the beds that look free for the dates and warns about the site grade, with the exception route named', async () => {
    const p = await mkProperty({ beds: 2 })
    await setConfigValue('eligibility.min_grade', 6, p.siteId)
    const res = await who('Res')
    await setStaff(res.staffId, { gender: 'male', grade: 3 })
    const pv = (await requestPreview(getDb(), res.rc.actor, { siteId: p.siteId, from: day(5), to: day(20), now: res.rc.clock.now() }))!
    expect(pv.blockers).toEqual([])
    expect(pv.person).toEqual({ name: expect.any(String), self: true })
    expect(pv.problems.map(x => x.text).join(' ')).toMatch(/grade 6 or above.*Policy Approver can allow an exception/)
    expect(pv.freeBeds).toBe(0) // the grade rule makes every bed here ineligible
    await setStaff(res.staffId, { gender: 'male', grade: 7 })
    const ok = (await requestPreview(getDb(), res.rc.actor, { siteId: p.siteId, from: day(5), to: day(20), now: res.rc.clock.now() }))!
    expect(ok.freeBeds).toBe(2)
    expect(ok.problems).toEqual([])
  })

  it('reports hard stops (an open request, a person who has left, an unknown employee ID) and hides grade and gender from Reception', async () => {
    const p = await mkProperty({ beds: 1 })
    await setConfigValue('eligibility.min_grade', 6, p.siteId)
    const rec = await who('Rec', { siteIds: [p.siteId] })
    const aa = await who('AA', { siteIds: [p.siteId] })
    const low = await mkStaff({ grade: 2 })
    const forRec = (await requestPreview(getDb(), rec.rc.actor, { employeeId: low.employeeId, siteId: p.siteId, from: day(5), to: day(9), now: rec.rc.clock.now() }))!
    expect(forRec.problems.map(x => x.text).join(' ')).not.toMatch(/grade/i) // Reception cannot see grade, so it must not be inferable
    const forAa = (await requestPreview(getDb(), aa.rc.actor, { employeeId: low.employeeId, siteId: p.siteId, from: day(5), to: day(9), now: aa.rc.clock.now() }))!
    expect(forAa.problems.map(x => x.text).join(' ')).toMatch(/grade 6/)

    const unknown = (await requestPreview(getDb(), aa.rc.actor, { employeeId: 'NOPE-1', siteId: p.siteId, from: day(5), now: aa.rc.clock.now() }))!
    expect(unknown.blockers[0]).toMatch(/No staff member has that employee ID/)
    const left = await mkStaff({ status: 'left' })
    expect((await requestPreview(getDb(), aa.rc.actor, { staffId: left.id, siteId: p.siteId, from: day(5), now: aa.rc.clock.now() }))!.blockers[0]).toMatch(/not an active employee/)
    const busy = await mkStaff()
    await mkRequest({ staffId: busy.id, siteId: p.siteId })
    expect((await requestPreview(getDb(), aa.rc.actor, { staffId: busy.id, siteId: p.siteId, from: day(5), now: aa.rc.clock.now() }))!.blockers[0]).toMatch(/already has an open request/)
  })

  it('a Resident cannot look at somebody else (404), a Reception site outside theirs is 404; over the API a bad date is a field error', async () => {
    const p = await mkProperty({ beds: 1 })
    const res = await who('Res')
    const other = await mkStaff()
    expect(await requestPreview(getDb(), res.rc.actor, { staffId: other.id, siteId: p.siteId, from: day(5), now: res.rc.clock.now() })).toBeUndefined()
    // an employee ID typed by a Resident is ignored: they only ever see the picture for themselves
    expect((await requestPreview(getDb(), res.rc.actor, { employeeId: other.employeeId, siteId: p.siteId, from: day(5), now: res.rc.clock.now() }))!.person.self).toBe(true)
    const rec = await who('Rec', { siteIds: [p.siteId] })
    const far = await mkSite()
    expect(await requestPreview(getDb(), rec.rc.actor, { staffId: other.id, siteId: far, from: day(5), now: rec.rc.clock.now() })).toBeUndefined()
    const bad = await call(previewRoute, { cookie: await res.cookie(), path: `/api/v1/requests/preview?siteId=${p.siteId}&from=nope` })
    expect(bad.status).toBe(422)
    const good = await call(previewRoute, { cookie: await res.cookie(), path: `/api/v1/requests/preview?siteId=${p.siteId}&from=${day(5)}&to=${day(15)}` })
    expect(good.status).toBe(200)
    expect(good.body.data.freeBeds).toBe(1)
  })
})

describe('My accommodation', () => {
  it('shows the open request, explains a rejection for a while, and the reservation once approved', async () => {
    const s = await scenario()
    const res = await who('Res')
    const now = res.rc.clock.now()
    expect(await myAccommodation(getDb(), res.staffId, now)).toEqual({ request: null, reservation: null })
    const { requestId } = must(await submitRequest(res.rc, { siteId: s.siteId, arrivalDate: day(5), endDate: day(25), stayType: 'contract', note: null }))
    const open = (await myAccommodation(getDb(), res.staffId, now)).request!
    expect(open).toMatchObject({ id: requestId, status: 'submitted', canCancel: true, canEdit: false, siteName: expect.any(String) })

    must(await rejectRequest(s.aa.rc, { requestId, reason: 'No beds this month' }))
    const rejected = (await myAccommodation(getDb(), res.staffId, now)).request!
    expect(rejected).toMatchObject({ status: 'rejected', decisionReason: 'No beds this month', canCancel: false })

    const again = must(await submitRequest(res.rc, { siteId: s.siteId, arrivalDate: day(6), endDate: day(26), stayType: 'contract', note: null }))
    must(await approveRequest(s.aa.rc, { requestId: again.requestId, bedId: s.bedIds[0] }))
    const done = await myAccommodation(getDb(), res.staffId, now)
    expect(done.request).toBeNull() // approved: the reservation replaces it
    expect(done.reservation).toMatchObject({ status: 'reserved', from: day(6), to: day(26) })
    expect(done.reservation!.bedLabel).toMatch(/^Bed .+, Room .+, .+$/)
    expect(Date.parse(done.reservation!.noShowDeadline)).toBe(Date.parse(`${day(6)}T12:00:00Z`) + 24 * 3600_000)
    // never someone else's
    const stranger = await who('Res')
    expect(await myAccommodation(getDb(), stranger.staffId, now)).toEqual({ request: null, reservation: null })
  })
})

describe('the exception report', () => {
  it('lists reason, evidence and every use; Policy Approvers see their sites, Super Admin all, Auditor their sites; AA and Reception are refused', async () => {
    const p = await mkProperty({ beds: 0 })
    const room = await mkRoom(p.siteId, { gender: 'male' })
    const bed = await mkBed(room)
    const aa = await who('AA', { siteIds: [p.siteId] })
    const approver = await who('Mgr', { siteIds: [p.siteId], caps: ['PolicyApprover'] })
    const woman = await mkStaff({ gender: 'female' })
    const requestId = await mkRequest({ staffId: woman.id, siteId: p.siteId, arrival: day(10), end: day(40) })
    must(await requestException(aa.rc, { requestId, bedId: bed, reason: 'Only vacancy' }))
    must(await grantException(approver.rc, { requestId, kinds: ['gender'], reason: 'Manager agreed', evidence: 'Memo 7' }))
    const rv = must(await approveRequest(aa.rc, { requestId, bedId: bed }))

    const mine = (await listExceptions(getDb(), approver.rc.actor))!.find(e => e.requestId === requestId)!
    expect(mine).toMatchObject({ kind: 'gender', name: expect.any(String), reason: 'Manager agreed', evidence: 'Memo 7', revoked: false })
    expect(mine.uses.map(u => u.usedRef)).toEqual([rv.reservationId])

    const sa = await who('SA'); const aud = await who('Aud', { siteIds: [p.siteId] })
    expect((await listExceptions(getDb(), sa.rc.actor))!.some(e => e.id === mine.id)).toBe(true)
    expect((await listExceptions(getDb(), aud.rc.actor))!.some(e => e.id === mine.id)).toBe(true)
    const otherPa = await who('Mgr', { siteIds: [(await mkProperty()).siteId], caps: ['PolicyApprover'] })
    expect((await listExceptions(getDb(), otherPa.rc.actor))!.some(e => e.id === mine.id)).toBe(false) // another site's exceptions are not theirs
    const otherAud = await who('Aud', { siteIds: [(await mkProperty()).siteId] })
    expect((await listExceptions(getDb(), otherAud.rc.actor))!.some(e => e.id === mine.id)).toBe(false)

    expect(exceptionReportScope(aa.rc.actor)).toBeNull()
    const rec = await who('Rec', { siteIds: [p.siteId] })
    expect(await listExceptions(getDb(), rec.rc.actor)).toBeNull()
    expect((await call(exceptionsRoute, { cookie: await aa.cookie() })).status).toBe(403)
    expect((await call(exceptionsRoute, { cookie: await rec.cookie() })).status).toBe(403)
    expect((await call(exceptionsRoute, { cookie: await sa.cookie() })).status).toBe(200)
    expect((await call(exceptionsRoute, { cookie: await approver.cookie() })).status).toBe(200)
  })
})

describe('the approval clock milestones (pure)', () => {
  const MON = Date.UTC(2026, 9, 12, 9) // a Monday, 09:00
  it('reminder at 1 business day, backup at the SLA, escalation one day later; nothing after that; weekends do not count', () => {
    expect(nextMilestone(MON, MON, 2, DEFAULT_CALENDAR)).toEqual({ label: 'Reminder', at: MON + 86_400_000 })
    expect(nextMilestone(MON, MON + 86_400_000 + 1000, 2, DEFAULT_CALENDAR)).toEqual({ label: 'Routed to backup', at: MON + 2 * 86_400_000 })
    expect(nextMilestone(MON, MON + 2 * 86_400_000 + 1000, 2, DEFAULT_CALENDAR)).toEqual({ label: 'Escalation', at: MON + 3 * 86_400_000 })
    expect(nextMilestone(MON, MON + 3 * 86_400_000 + 1000, 2, DEFAULT_CALENDAR)).toBeUndefined()
    const FRI = Date.UTC(2026, 9, 16, 9) // filed on a Friday: Saturday and Sunday do not count, so the first business day is complete on Monday
    expect(nextMilestone(FRI, FRI, 2, DEFAULT_CALENDAR)!.at).toBe(FRI + 3 * 86_400_000)
  })
})
