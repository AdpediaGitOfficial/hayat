import { afterAll, describe, expect, it } from 'vitest'
import { admin, call, closeAll, uniq } from '../harness'
import { mkBed, mkRoom, reserve, setConfigValue, setState } from '../fixtures2'
import { auditActions, claimsOf, count, day, mkProperty, mkRequest, mkStaff, must, notifCount, requestRow, reservationsOf, scenario, setStaff, who } from './helpers'
import { approveRequest } from '@/server/commands/requests/approve'
import { declineException, grantException, requestException } from '@/server/commands/requests/exceptions'
import { submitRequest } from '@/server/commands/requests/submit'
import { getRequestDetail } from '@/server/queries/requests/detail'
import { bedsForRequest } from '@/server/queries/requests/beds'
import { listExceptions } from '@/server/queries/requests/exceptions'
import { getDb } from '@/server/db/client'
import { POST as approveRoute } from '../../../app/api/v1/requests/[id]/approve/route'
import { POST as grantRoute } from '../../../app/api/v1/requests/[id]/exception/grant/route'

afterAll(closeAll)

/** A Policy Approver: any role at the site plus the capability. Manager here, so they can decide exceptions but not pick beds. */
const pa = (siteId: string) => who('Mgr', { siteIds: [siteId], caps: ['PolicyApprover'] })

describe('approval = pick the bed and create the reservation, atomically (D-44)', () => {
  it('creates the claim [arrival, departure), the reservation (source request), approves the request, audits and notifies once', async () => {
    const s = await scenario()
    const out = must(await approveRequest(s.aa.rc, { requestId: s.requestId, bedId: s.bedIds[0] }))
    expect(out.from).toBe(day(10))
    expect(out.to).toBe(day(40))
    expect((await claimsOf(s.bedIds[0])).map(c => c.period)).toEqual([`[${day(10)},${day(40)})`])
    const [rv] = await reservationsOf(s.requestId)
    expect(rv).toMatchObject({ bed_id: s.bedIds[0], staff_id: s.person.id, status: 'reserved', source: 'request', stay_type: 'contract', created_by: s.aa.user.id })
    expect(new Date(rv.eta).toISOString()).toBe(`${day(10)}T12:00:00.000Z`)
    expect(await requestRow(s.requestId)).toMatchObject({ status: 'approved', decided_by: s.aa.user.id })
    expect(await auditActions(s.requestId)).toEqual(['requests.request.approved'])
    expect(await auditActions(rv.id)).toEqual(['requests.reservation.created'])
    expect(await notifCount(`request:${s.requestId}:approved:resident`)).toBe(1)
    expect(await notifCount(`reservation:${rv.id}:created`)).toBe(1)
  })

  it('a retried approval (same admin, same bed) answers the same and writes nothing more (AT-030 style)', async () => {
    const s = await scenario()
    const first = must(await approveRequest(s.aa.rc, { requestId: s.requestId, bedId: s.bedIds[0] }))
    const again = must(await approveRequest(s.aa.rc, { requestId: s.requestId, bedId: s.bedIds[0] }))
    expect(again.repeated).toBe(true)
    expect(again.reservationId).toBe(first.reservationId)
    expect(await reservationsOf(s.requestId)).toHaveLength(1)
    expect(await claimsOf(s.bedIds[0])).toHaveLength(1)
    expect((await auditActions(s.requestId)).filter(a => a === 'requests.request.approved')).toHaveLength(1)
    expect(await notifCount(`request:${s.requestId}:approved:%`)).toBe(1)
    // a different bed after approval is not a retry: it is refused
    const other = await approveRequest(s.aa.rc, { requestId: s.requestId, bedId: s.bedIds[1] })
    expect(other.ok).toBe(false)
  })

  it('an open-ended permanent request holds the bed open-ended, and the bed must be at the request\'s site', async () => {
    const s = await scenario()
    const other = await mkProperty({ beds: 1 })
    const res = await who('Res')
    const r = must(await submitRequest(res.rc, { siteId: s.siteId, arrivalDate: day(3), endDate: null, stayType: 'permanent', note: null }))
    const wrongSite = await approveRequest(s.aa.rc, { requestId: r.requestId, bedId: other.bedIds[0] })
    expect(wrongSite.ok).toBe(false)
    if (!wrongSite.ok) { expect(wrongSite.code).toBe('invalid'); expect(wrongSite.fields?.bedId).toBeTruthy() }
    expect(await claimsOf(other.bedIds[0])).toHaveLength(0)
    must(await approveRequest(s.aa.rc, { requestId: r.requestId, bedId: s.bedIds[1] }))
    expect((await claimsOf(s.bedIds[1])).map(c => c.period)).toEqual([`[${day(3)},)`])
  })

  it('readiness gates check-in, not the reservation (D-18): a bed that needs cleaning can be approved', async () => {
    const s = await scenario({ beds: 0 })
    const dirty = await mkBed(s.roomId, { state: 'needs_cleaning' })
    expect(must(await approveRequest(s.aa.rc, { requestId: s.requestId, bedId: dirty })).bedId).toBe(dirty)
  })

  it('same-day turnover: arrival on the previous resident\'s departure day is fine; a shared night is a conflict', async () => {
    const s = await scenario({ beds: 1 })
    await reserve(s.bedIds[0], day(2), day(10))
    must(await approveRequest(s.aa.rc, { requestId: s.requestId, bedId: s.bedIds[0] })) // arrival day(10) == departure day(10)
    const p2 = await mkStaff()
    const overlapping = await mkRequest({ staffId: p2.id, siteId: s.siteId, arrival: day(39), end: day(45) })
    const r = await approveRequest(s.aa.rc, { requestId: overlapping, bedId: s.bedIds[0] })
    expect(r.ok).toBe(false)
    if (!r.ok) expect((r.detail as any).reason).toBe('bed_taken')
  })

  it('a bed that is blocked, or held by an offer, is refused with the reason and nothing is created', async () => {
    const s = await scenario({ beds: 3 })
    await setState(s.bedIds[0], 'blocked')
    const b = await approveRequest(s.aa.rc, { requestId: s.requestId, bedId: s.bedIds[0] })
    expect(b.ok).toBe(false)
    if (!b.ok) expect((b.detail as any).reason).toBe('bed_unavailable')
    const held = await admin().query<{ id: string }>(`INSERT INTO bed_claim (bed_id, kind, period) VALUES ($1, 'offer_hold', $2::daterange) RETURNING id`, [s.bedIds[1], `[${day(5)},${day(60)})`])
    const h = await approveRequest(s.aa.rc, { requestId: s.requestId, bedId: s.bedIds[1] })
    expect(h.ok).toBe(false)
    if (!h.ok) { expect((h.detail as any).reason).toBe('bed_held'); expect(h.next).toBeTruthy() }
    expect(held.rows).toHaveLength(1)
    expect(await reservationsOf(s.requestId)).toHaveLength(0)
    expect((await requestRow(s.requestId)).status).toBe('submitted')
  })

  it('ATOMIC: a failure after the bed was allocated rolls the claim back too (no reservation, no claim, request still waiting, no notification)', async () => {
    const s = await scenario({ beds: 1 })
    const fn = uniq('boom').replace(/-/g, '_')
    await admin().query(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'simulated failure'; END $$`)
    await admin().query(`CREATE TRIGGER ${fn} BEFORE INSERT ON reservation FOR EACH ROW WHEN (NEW.staff_id = '${s.person.id}') EXECUTE FUNCTION ${fn}()`)
    try {
      const r = await approveRequest(s.aa.rc, { requestId: s.requestId, bedId: s.bedIds[0] })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.code).toBe('internal')
      expect(await claimsOf(s.bedIds[0])).toHaveLength(0)
      expect(await reservationsOf(s.requestId)).toHaveLength(0)
      expect((await requestRow(s.requestId)).status).toBe('submitted')
      expect(await auditActions(s.requestId)).toEqual([])
      expect(await notifCount(`request:${s.requestId}:approved%`)).toBe(0)
    } finally {
      await admin().query(`DROP TRIGGER ${fn} ON reservation`)
      await admin().query(`DROP FUNCTION ${fn}()`)
    }
    must(await approveRequest(s.aa.rc, { requestId: s.requestId, bedId: s.bedIds[0] })) // and it works once the fault is gone
  })

  it('AT-008 concurrent approvals for the same bed and dates: exactly one wins, the loser gets an actionable conflict', async () => {
    for (let round = 0; round < 3; round++) {
      const p = await mkProperty({ beds: 3 })
      const aa1 = await who('AA', { siteIds: [p.siteId] })
      const aa2 = await who('AA', { siteIds: [p.siteId] })
      const reqA = await mkRequest({ staffId: (await mkStaff()).id, siteId: p.siteId, arrival: day(8), end: day(30) })
      const reqB = await mkRequest({ staffId: (await mkStaff()).id, siteId: p.siteId, arrival: day(8), end: day(30) })
      const results = await Promise.all([
        approveRequest(aa1.rc, { requestId: reqA, bedId: p.bedIds[0] }),
        approveRequest(aa2.rc, { requestId: reqB, bedId: p.bedIds[0] }),
      ])
      expect(results.filter(r => r.ok), `round ${round}`).toHaveLength(1)
      const lost = results.find(r => !r.ok)!
      expect(lost.ok).toBe(false)
      if (!lost.ok) {
        expect(lost.code).toBe('conflict')
        expect((lost.detail as any).reason).toBe('bed_taken')
        expect(lost.next).toBeTruthy()
        expect(lost.owner).toBeTruthy()
        expect(((lost.detail as any).suggestions as any[]).map(x => x.bedId).sort()).toEqual([p.bedIds[1], p.bedIds[2]].sort())
      }
      expect(await claimsOf(p.bedIds[0])).toHaveLength(1)
      expect(await count(`SELECT count(*) FROM reservation WHERE bed_id = $1`, [p.bedIds[0]])).toBe(1)
      const loserReq = results[0].ok ? reqB : reqA
      expect((await requestRow(loserReq)).status).toBe('submitted') // still waiting; pick the next bed
    }
  })

  it('two admins approving the SAME request: one wins, the other is told it is already approved', async () => {
    const s = await scenario({ beds: 2 })
    const aa2 = await who('AA', { siteIds: [s.siteId] })
    const results = await Promise.all([
      approveRequest(s.aa.rc, { requestId: s.requestId, bedId: s.bedIds[0] }),
      approveRequest(aa2.rc, { requestId: s.requestId, bedId: s.bedIds[1] }),
    ])
    expect(results.filter(r => r.ok)).toHaveLength(1)
    expect(await reservationsOf(s.requestId)).toHaveLength(1)
    expect((await claimsOf(s.bedIds[0])).length + (await claimsOf(s.bedIds[1])).length).toBe(1)
  })
})

describe('separation of duties and scope on approval', () => {
  it('an AA cannot approve their own request, nor one they filed on someone\'s behalf (D-26)', async () => {
    const s = await scenario()
    const ownReq = await mkRequest({ staffId: s.aa.staffId, siteId: s.siteId, arrival: day(10), end: day(20) })
    const r = await approveRequest(s.aa.rc, { requestId: ownReq, bedId: s.bedIds[0] })
    expect(r.ok).toBe(false)
    if (!r.ok) { expect(r.code).toBe('separation_of_duties'); expect(r.next).toBeTruthy() }
    expect(await claimsOf(s.bedIds[0])).toHaveLength(0)

    const person = await mkStaff()
    const filed = must(await submitRequest(s.aa.rc, { siteId: s.siteId, staffId: person.id, arrivalDate: day(5), endDate: day(15), stayType: 'contract', note: null }))
    const self = await approveRequest(s.aa.rc, { requestId: filed.requestId, bedId: s.bedIds[0] })
    expect(self.ok).toBe(false)
    if (!self.ok) expect(self.code).toBe('separation_of_duties')
    const colleague = await who('AA', { siteIds: [s.siteId] })
    must(await approveRequest(colleague.rc, { requestId: filed.requestId, bedId: s.bedIds[0] }))
    // a Super Admin is also bound: they cannot approve their own
    const sa = await who('SA')
    const saReq = await mkRequest({ staffId: sa.staffId, siteId: s.siteId, arrival: day(10), end: day(20) })
    const own = await approveRequest(sa.rc, { requestId: saReq, bedId: s.bedIds[1] })
    expect(own.ok).toBe(false)
    if (!own.ok) expect(own.code).toBe('separation_of_duties')
  })

  it('Reception cannot approve (403); an AA of another site gets 404; both over the API', async () => {
    const s = await scenario()
    const rec = await who('Rec', { siteIds: [s.siteId] })
    const outsider = await who('AA', { siteIds: [(await mkProperty()).siteId] })
    const asRec = await call(approveRoute, { cookie: await rec.cookie(), params: { id: s.requestId }, body: { bedId: s.bedIds[0] } })
    expect(asRec.status).toBe(403)
    const asOutsider = await call(approveRoute, { cookie: await outsider.cookie(), params: { id: s.requestId }, body: { bedId: s.bedIds[0] } })
    expect(asOutsider.status).toBe(404)
    const asAa = await call(approveRoute, { cookie: await s.aa.cookie(), params: { id: s.requestId }, body: { bedId: s.bedIds[0] } })
    expect(asAa.status).toBe(200)
    expect(asAa.body.data.reservationId).toBeTruthy()
    expect(await claimsOf(s.bedIds[0])).toHaveLength(1)
  })

  it('suggested beds: eligible and free for the dates first; none for an AA of another site', async () => {
    const s = await scenario({ beds: 3 })
    await reserve(s.bedIds[0], day(12), day(20))
    const sug = (await bedsForRequest(getDb(), s.aa.rc.actor, s.requestId, s.aa.rc.clock.now()))!
    expect(sug.suggestions.map(x => x.bedId).sort()).toEqual([s.bedIds[1], s.bedIds[2]].sort())
    expect(sug.beds.find(b => b.bedId === s.bedIds[0])?.free).toBe(false)
    const outsider = await who('AA', { siteIds: [(await mkProperty()).siteId] })
    expect(await bedsForRequest(getDb(), outsider.rc.actor, s.requestId, outsider.rc.clock.now())).toBeUndefined()
  })
})

describe('AT-006 gender restriction, AT-007 grade entitlement (Policy Approver exceptions, D-25)', () => {
  async function restricted(o: { gender: 'male' | 'female'; personGender: 'male' | 'female'; grade?: number }) {
    const p = await mkProperty({ beds: 1 })
    const room = await mkRoom(p.siteId, { gender: o.gender })
    const bed = await mkBed(room)
    const aa = await who('AA', { siteIds: [p.siteId] })
    const person = await mkStaff({ gender: o.personGender, grade: o.grade ?? 5 })
    const requestId = await mkRequest({ staffId: person.id, siteId: p.siteId, arrival: day(10), end: day(40) })
    return { ...p, bed, aa, person, requestId, approver: await pa(p.siteId) }
  }

  it('AT-006: a female resident cannot be allocated to a male-only room: blocked, no reservation, the Policy Approver is named', async () => {
    const t = await restricted({ gender: 'male', personGender: 'female' })
    const r = await approveRequest(t.aa.rc, { requestId: t.requestId, bedId: t.bed })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe('conflict')
      expect((r.detail as any).reason).toBe('not_eligible')
      expect((r.detail as any).exceptionable).toBe(true)
      expect((r.detail as any).policyApproverException).toBe(true)
      expect(r.owner).toBe('Policy Approver')
      expect(r.next).toMatch(/Policy Approver/)
      expect(r.reason).toMatch(/male-only/)
    }
    expect(await claimsOf(t.bed)).toHaveLength(0)
    expect(await reservationsOf(t.requestId)).toHaveLength(0)
    expect((await requestRow(t.requestId)).status).toBe('submitted')

    // the exception workflow: AA asks, PA grants with reason and evidence, AA approves, the use is recorded
    const ask = must(await requestException(t.aa.rc, { requestId: t.requestId, bedId: t.bed, reason: 'Only vacancy near her department' }))
    expect(ask.kinds).toEqual(['gender'])
    expect((await requestRow(t.requestId)).status).toBe('pending_approval')
    const blockedMeanwhile = await approveRequest(t.aa.rc, { requestId: t.requestId, bedId: t.bed })
    expect(blockedMeanwhile.ok).toBe(false)
    if (!blockedMeanwhile.ok) expect(blockedMeanwhile.owner).toBe('Policy Approver')

    const granted = must(await grantException(t.approver.rc, { requestId: t.requestId, kinds: ['gender'], reason: 'Approved by Accommodation Manager', evidence: 'Email from HR head, 12 Oct' }))
    expect(granted.status).toBe('submitted')
    expect(await requestRow(t.requestId)).toMatchObject({ status: 'submitted', exception_by: t.approver.user.id })
    const ok = must(await approveRequest(t.aa.rc, { requestId: t.requestId, bedId: t.bed }))
    expect(ok.exceptionIds).toHaveLength(1)
    expect(await claimsOf(t.bed)).toHaveLength(1)
    const uses = (await admin().query(`SELECT * FROM eligibility_exception_use WHERE exception_id = $1`, [ok.exceptionIds[0]])).rows
    expect(uses).toHaveLength(1)
    expect(uses[0]).toMatchObject({ used_for: 'reservation', used_ref: ok.reservationId, used_by: t.aa.user.id })
    expect(await auditActions(t.requestId)).toEqual(['requests.exception.requested', 'requests.exception.granted', 'requests.request.approved'])
    expect(await notifCount(`request:${t.requestId}:exception:%`)).toBe(1)
    expect(await notifCount(`request:${t.requestId}:exception-granted:%`)).toBe(1)

    // reported: the exception and its use appear in the report for the Policy Approver, with reason and evidence
    const report = (await listExceptions(getDb(), t.approver.rc.actor))!
    const mine = report.find(e => e.id === ok.exceptionIds[0])!
    expect(mine).toMatchObject({ kind: 'gender', reason: 'Approved by Accommodation Manager', evidence: 'Email from HR head, 12 Oct', requestId: t.requestId })
    expect(mine.uses).toHaveLength(1)
  })

  it('AT-007: the site minimum grade blocks the allocation unless the exception workflow completes', async () => {
    const p = await mkProperty({ beds: 2 })
    await setConfigValue('eligibility.min_grade', 5, p.siteId)
    const aa = await who('AA', { siteIds: [p.siteId] })
    const approver = await pa(p.siteId)
    const person = await mkStaff({ gender: 'male', grade: 3 })
    const requestId = await mkRequest({ staffId: person.id, siteId: p.siteId, arrival: day(10), end: day(40) })

    const blocked = await approveRequest(aa.rc, { requestId, bedId: p.bedIds[0] })
    expect(blocked.ok).toBe(false)
    if (!blocked.ok) { expect((blocked.detail as any).failed).toContain('grade'); expect(blocked.reason).toMatch(/grade 5\+/); expect(blocked.owner).toBe('Policy Approver') }
    // the workflow has not completed yet: asked, not granted
    must(await requestException(aa.rc, { requestId, bedId: p.bedIds[0], reason: 'Senior trainee on a temporary assignment' }))
    const stillBlocked = await approveRequest(aa.rc, { requestId, bedId: p.bedIds[0] })
    expect(stillBlocked.ok).toBe(false)
    expect(await claimsOf(p.bedIds[0])).toHaveLength(0)
    // declined: back with the admin, which still cannot approve
    must(await declineException(approver.rc, { requestId, reason: 'Entitlement is clear' }))
    expect((await requestRow(requestId)).status).toBe('submitted')
    expect((await approveRequest(aa.rc, { requestId, bedId: p.bedIds[0] })).ok).toBe(false)
    expect(await count(`SELECT count(*) FROM eligibility_exception WHERE request_id = $1`, [requestId])).toBe(0)
    // asked again, granted: now it works, and only for THIS request
    must(await requestException(aa.rc, { requestId, bedId: p.bedIds[0], reason: 'Director has confirmed the assignment' }))
    must(await grantException(approver.rc, { requestId, kinds: ['grade'], reason: 'Director confirmed', evidence: 'Memo 14/10' }))
    must(await approveRequest(aa.rc, { requestId, bedId: p.bedIds[0] }))
    const other = await mkStaff({ gender: 'male', grade: 3 })
    const otherReq = await mkRequest({ staffId: other.id, siteId: p.siteId, arrival: day(10), end: day(40) })
    expect((await approveRequest(aa.rc, { requestId: otherReq, bedId: p.bedIds[1] })).ok).toBe(false) // the exception does not travel
    // and the person's exception does not travel to a new request either
    const asks = (await admin().query(`SELECT status FROM request_exception_ask WHERE request_id = $1 ORDER BY created_at`, [requestId])).rows.map(r => r.status)
    expect(asks).toEqual(['declined', 'granted'])
  })

  it('the exception needs reason AND evidence (422 over the API); a retried grant adds nothing', async () => {
    const t = await restricted({ gender: 'female', personGender: 'male' })
    must(await requestException(t.aa.rc, { requestId: t.requestId, bedId: t.bed, reason: 'Needed' }))
    const cookie = await t.approver.cookie()
    const noEvidence = await call(grantRoute, { cookie, params: { id: t.requestId }, body: { kinds: ['gender'], reason: 'Approved by manager' } })
    expect(noEvidence.status).toBe(422)
    expect(noEvidence.body.fields.evidence).toBeTruthy()
    const noReason = await call(grantRoute, { cookie, params: { id: t.requestId }, body: { kinds: ['gender'], evidence: 'a memo' } })
    expect(noReason.status).toBe(422)
    const good = await call(grantRoute, { cookie, params: { id: t.requestId }, body: { kinds: ['gender'], reason: 'Approved by manager', evidence: 'a memo' } })
    expect(good.status).toBe(200)
    const retry = await call(grantRoute, { cookie, params: { id: t.requestId }, body: { kinds: ['gender'], reason: 'Approved by manager', evidence: 'a memo' } })
    expect(retry.status).toBe(200)
    expect(await count(`SELECT count(*) FROM eligibility_exception WHERE request_id = $1`, [t.requestId])).toBe(1)
    expect(await notifCount(`request:${t.requestId}:exception-granted:%`)).toBe(1)
    expect((await auditActions(t.requestId)).filter(a => a === 'requests.exception.granted')).toHaveLength(1)
  })

  it('SoD: a Policy Approver cannot grant an exception on their own request, nor on one they filed; an AA cannot grant at all', async () => {
    const t = await restricted({ gender: 'male', personGender: 'female' })
    const selfApprover = await pa(t.siteId)
    await setStaff(selfApprover.staffId, { gender: 'female', grade: 5 })
    const selfReq = await mkRequest({ staffId: selfApprover.staffId, siteId: t.siteId, arrival: day(10), end: day(40), status: 'pending_approval' })
    const own = await grantException(selfApprover.rc, { requestId: selfReq, kinds: ['gender'], reason: 'mine', evidence: 'mine' })
    expect(own.ok).toBe(false)
    if (!own.ok) expect(own.code).toBe('separation_of_duties')

    // an AA without the capability: 403 on the exception route
    const noCap = await grantException(t.aa.rc, { requestId: t.requestId, kinds: ['gender'], reason: 'x', evidence: 'y' })
    expect(noCap.ok).toBe(false)
    if (!noCap.ok) expect(noCap.code).toBe('forbidden')
    // a Policy Approver of another site gets 404
    const away = await pa((await mkProperty()).siteId)
    const miss = await grantException(away.rc, { requestId: t.requestId, kinds: ['gender'], reason: 'x', evidence: 'y' })
    expect(miss.ok).toBe(false)
    if (!miss.ok) expect(miss.code).toBe('not_found')
  })

  it('a Policy Approver who also filed the request on someone\'s behalf cannot grant it (D-26)', async () => {
    const t = await restricted({ gender: 'male', personGender: 'female' })
    const both = await who('Rec', { siteIds: [t.siteId], caps: ['PolicyApprover'] })
    const person = await mkStaff({ gender: 'female' })
    const filed = must(await submitRequest(both.rc, { siteId: t.siteId, staffId: person.id, arrivalDate: day(5), endDate: day(15), stayType: 'contract', note: null }))
    const r = await grantException(both.rc, { requestId: filed.requestId, kinds: ['gender'], reason: 'x', evidence: 'y' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('separation_of_duties')
    expect(await count(`SELECT count(*) FROM eligibility_exception WHERE request_id = $1`, [filed.requestId])).toBe(0)
  })

  it('no exception can be asked for someone who has left, nor when the person is already eligible', async () => {
    const t = await restricted({ gender: 'male', personGender: 'male' })
    const fine = await requestException(t.aa.rc, { requestId: t.requestId, bedId: t.bed, reason: 'just in case' })
    expect(fine.ok).toBe(false)
    if (!fine.ok) expect((fine.detail as any).reason).toBe('no_exception_needed')
    await admin().query(`UPDATE staff_profile SET employment_status = 'left', left_at = now() WHERE id = $1`, [t.person.id])
    const left = await requestException(t.aa.rc, { requestId: t.requestId, bedId: t.bed, reason: 'please' })
    expect(left.ok).toBe(false)
    if (!left.ok) expect((left.detail as any).reason).toBe('not_exceptionable')
    const a = await approveRequest(t.aa.rc, { requestId: t.requestId, bedId: t.bed })
    expect(a.ok).toBe(false)
    if (!a.ok) { expect((a.detail as any).exceptionable).toBe(false); expect(a.owner).toBe('Accommodation Admin') }
  })

  it('the request detail shows the exception route to staff and hides it from the resident', async () => {
    const t = await restricted({ gender: 'male', personGender: 'female' })
    must(await requestException(t.aa.rc, { requestId: t.requestId, bedId: t.bed, reason: 'Only vacancy' }))
    const forPa = (await getRequestDetail(getDb(), t.approver.rc, t.requestId, t.aa.rc.clock.now()))!
    expect(forPa.status).toBe('pending_approval')
    expect(forPa.exception?.asks).toHaveLength(1)
    expect(forPa.can.grantException).toBe(true)
    expect(forPa.can.approve).toBe(false) // a Policy Approver (Manager) does not pick beds
    const forAa = (await getRequestDetail(getDb(), t.aa.rc, t.requestId, t.aa.rc.clock.now()))!
    expect(forAa.can.approve).toBe(false) // waiting for the exception
    expect(forAa.can.grantException).toBe(false)
  })
})
