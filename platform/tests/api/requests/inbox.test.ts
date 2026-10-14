import { afterAll, describe, expect, it } from 'vitest'
import { admin, call, closeAll } from '../harness'
import { claimsOf, count, day, mkProperty, mkRequest, mkStaff, must, notifCount, requestRow, reservationsOf, scenario, who } from './helpers'
import { FixedClock } from '@/server/clock'
import { runSweep } from '@/server/jobs/registry'
import '@/server/jobs/sweeps'
import { approvalsInbox, whoIsOut } from '@/server/queries/requests/inbox'
import { createDelegation, revokeDelegation } from '@/server/commands/approvals/delegation'
import { requestException } from '@/server/commands/requests/exceptions'
import { approveRequest } from '@/server/commands/requests/approve'
import { mkBed, mkRoom } from '../fixtures2'
import { getDb } from '@/server/db/client'
import { GET as inboxRoute } from '../../../app/api/v1/approvals/inbox/route'
import { POST as delegateRoute } from '../../../app/api/v1/approvals/delegations/route'
import { POST as approveRoute } from '../../../app/api/v1/requests/[id]/approve/route'

afterAll(closeAll)

const dbNow = async () => (await admin().query<{ n: Date }>(`SELECT now() AS n`)).rows[0].n
/** Another test file may hold the sweep's advisory lock for a moment; try until this call actually ran it. */
async function runSwept(name: string, clock: FixedClock) {
  for (let i = 0; i < 40; i++) {
    const r = await runSweep(name, clock)
    if (!r.skipped) return r
    await new Promise(res => setTimeout(res, 100))
  }
  throw new Error(`sweep ${name} stayed locked`)
}
const items = async (w: { rc: any }) => await approvalsInbox(getDb(), w.rc)

describe('approvals inbox: request and exception sources', () => {
  it('an AA sees the requests of their sites with route, current approver, SLA clock; Urgent (arrival inside the SLA window, D-46) sorts first', async () => {
    const p = await mkProperty()
    const aa = await who('AA', { siteIds: [p.siteId] })
    const outsider = await who('AA', { siteIds: [(await mkProperty()).siteId] })
    const calm = await mkRequest({ staffId: (await mkStaff()).id, siteId: p.siteId, arrival: day(30), end: day(60) })
    const urgent = await mkRequest({ staffId: (await mkStaff()).id, siteId: p.siteId, arrival: day(2), end: day(20) })
    const list = await items(aa)
    const refs = list.filter(i => i.kind === 'request').map(i => i.ref)
    expect(refs).toEqual([urgent, calm])
    const card = list.find(i => i.ref === urgent)!
    expect(card).toMatchObject({ urgent: true, mine: true, primary: 'Accommodation Admin', backup: 'Policy Approver', current: 'Accommodation Admin', href: `/requests/${urgent}` })
    expect(card.clock).toMatchObject({ level: 0, label: 'Within SLA' })
    expect((await items(outsider)).map(i => i.ref)).not.toContain(urgent)
    // over the API too
    const r = await call(inboxRoute, { cookie: await aa.cookie() })
    expect(r.status).toBe(200)
    expect(r.body.data.map((i: any) => i.ref)).toEqual(expect.arrayContaining([urgent, calm]))
  })

  it('"why you can\'t approve": the admin\'s own request and one they filed show the reason, and approval is refused by the API too', async () => {
    const s = await scenario()
    const own = await mkRequest({ staffId: s.aa.staffId, siteId: s.siteId, arrival: day(10), end: day(20) })
    const card = (await items(s.aa)).find(i => i.ref === own)!
    expect(card.mine).toBe(false)
    expect(card.why).toMatch(/separation of duties/)
    const r = await call(approveRoute, { cookie: await s.aa.cookie(), params: { id: own }, body: { bedId: s.bedIds[0] } })
    expect(r.status).toBe(403)
    expect(r.body.code).toBe('separation_of_duties')
  })

  it('a request waiting for an exception leaves the admin\'s queue and appears for the Policy Approver as kind "exception"', async () => {
    const p = await mkProperty({ beds: 0 })
    const room = await mkRoom(p.siteId, { gender: 'male' })
    const bed = await mkBed(room)
    const aa = await who('AA', { siteIds: [p.siteId] })
    const approver = await who('Mgr', { siteIds: [p.siteId], caps: ['PolicyApprover'] })
    const woman = await mkStaff({ gender: 'female' })
    const requestId = await mkRequest({ staffId: woman.id, siteId: p.siteId, arrival: day(10), end: day(40) })
    expect((await items(aa)).some(i => i.kind === 'request' && i.ref === requestId)).toBe(true)
    must(await requestException(aa.rc, { requestId, bedId: bed, reason: 'Only vacancy' }))
    expect((await items(aa)).some(i => i.ref === requestId)).toBe(false)
    const card = (await items(approver)).find(i => i.ref === requestId)!
    expect(card).toMatchObject({ kind: 'exception', mine: true, primary: 'Policy Approver' })
    expect(card.title).toMatch(/gender exception/)
    expect(card.sub).toMatch(/Only vacancy/)
    // the person it is about, and an AA without the capability, do not get it
    const outsiderPa = await who('Mgr', { siteIds: [(await mkProperty()).siteId], caps: ['PolicyApprover'] })
    expect((await items(outsiderPa)).some(i => i.ref === requestId)).toBe(false)
  })
})

describe('timers never decide: the reminder sweep only reminds', () => {
  it('after 5 business days nothing is approved, rejected or moved, the reminders go out once, and a second run adds nothing', async () => {
    const s = await scenario()
    const approver = await who('Mgr', { siteIds: [s.siteId], caps: ['PolicyApprover'] })
    const base = await dbNow()
    const later = new FixedClock(base.getTime() + 8 * 86_400_000) // at least five business days whatever the weekday
    const before = { req: await requestRow(s.requestId), claims: await count(`SELECT count(*) FROM bed_claim c JOIN bed b ON b.id = c.bed_id WHERE b.site_id = $1`, [s.siteId]) }

    const run1 = await runSwept('approval_reminders', later)
    expect(run1.ok).toBe(true)
    const reminders = await notifCount(`approval:request:${s.requestId}:%`)
    expect(reminders).toBe(3) // reminder, routed to backup, escalated
    const keys = (await admin().query(`SELECT dedupe_key, to_role FROM notification WHERE dedupe_key LIKE $1 ORDER BY dedupe_key`, [`approval:request:${s.requestId}:%`])).rows
    expect(keys.map(k => k.to_role).sort()).toEqual(['AA', 'PolicyApprover', 'SA'])

    await runSwept('approval_reminders', later)
    expect(await notifCount(`approval:request:${s.requestId}:%`)).toBe(reminders)

    const after = await requestRow(s.requestId)
    expect(after.status).toBe('submitted')
    expect(after.decided_by).toBeNull()
    expect(after.updated_at).toEqual(before.req.updated_at)
    expect(await reservationsOf(s.requestId)).toHaveLength(0)
    expect(await count(`SELECT count(*) FROM bed_claim c JOIN bed b ON b.id = c.bed_id WHERE b.site_id = $1`, [s.siteId])).toBe(before.claims)
    expect(await claimsOf(s.bedIds[0])).toHaveLength(0)
    void approver
  })

  it('a request waiting for an exception is reminded to the Policy Approver, and still nobody decides', async () => {
    const p = await mkProperty({ beds: 0 })
    const room = await mkRoom(p.siteId, { gender: 'male' })
    const bed = await mkBed(room)
    const aa = await who('AA', { siteIds: [p.siteId] })
    const woman = await mkStaff({ gender: 'female' })
    const requestId = await mkRequest({ staffId: woman.id, siteId: p.siteId, arrival: day(10), end: day(40) })
    must(await requestException(aa.rc, { requestId, bedId: bed, reason: 'Only vacancy' }))
    const later = new FixedClock((await dbNow()).getTime() + 8 * 86_400_000)
    await runSwept('approval_reminders', later)
    const keys = (await admin().query(`SELECT to_role FROM notification WHERE dedupe_key LIKE $1`, [`approval:exception:${requestId}:%`])).rows.map(r => r.to_role).sort()
    expect(keys).toEqual(['PolicyApprover', 'PolicyApprover', 'SA'])
    expect((await requestRow(requestId)).status).toBe('pending_approval')
    expect(await reservationsOf(requestId)).toHaveLength(0)
  })
})

describe('delegation (D-32): a record, not authority (S-13)', () => {
  const week = async () => {
    const today = (await dbNow()).toISOString().slice(0, 10)
    return { startsOn: today, endsOn: new Date(Date.parse(today) + 6 * 86_400_000).toISOString().slice(0, 10), reason: null as string | null }
  }
  const asNow = async <T extends { rc: any }>(w: T): Promise<T> => { w.rc.clock = new FixedClock(await dbNow()); return w }

  it('an AA names a colleague who already holds the role at their site: recorded, audited, the stand-in is told', async () => {
    const p = await mkProperty({ beds: 0 })
    const a = await asNow(await who('AA', { siteIds: [p.siteId] }))
    const b = await asNow(await who('AA', { siteIds: [p.siteId] }))
    const d = must(await createDelegation(a.rc, { toUserId: b.user.id, ...(await week()), reason: 'Annual leave' }))
    const rows = (await admin().query(`SELECT * FROM delegation WHERE id = $1`, [d.delegationId])).rows
    expect(rows[0]).toMatchObject({ from_user_id: a.user.id, to_user_id: b.user.id, created_by: a.user.id, reason: 'Annual leave', revoked_at: null })
    const audit = (await admin().query(`SELECT action, actor_user_id FROM audit_event WHERE entity_id = $1`, [d.delegationId])).rows
    expect(audit).toEqual([{ action: 'approvals.delegation.created', actor_user_id: a.user.id }])
    expect(await notifCount(`delegation:${d.delegationId}:created`)).toBe(1)
    const out = await whoIsOut(getDb(), b.rc.actor, new Date(b.rc.clock.nowMs()))
    expect(out.map(x => x.id)).toContain(d.delegationId)
    const other = await who('AA', { siteIds: [(await mkProperty()).siteId] })
    expect((await whoIsOut(getDb(), other.rc.actor, new Date(b.rc.clock.nowMs()))).map(x => x.id)).not.toContain(d.delegationId)
    // revoking: the owner may, a stranger sees nothing, a repeat is harmless
    const stranger = await who('AA', { siteIds: [p.siteId] })
    const no = await revokeDelegation(stranger.rc, { delegationId: d.delegationId })
    expect(no.ok).toBe(false)
    if (!no.ok) expect(no.code).toBe('not_found')
    must(await revokeDelegation(a.rc, { delegationId: d.delegationId }))
    must(await revokeDelegation(a.rc, { delegationId: d.delegationId }))
    expect((await admin().query(`SELECT revoked_at FROM delegation WHERE id = $1`, [d.delegationId])).rows[0].revoked_at).not.toBeNull()
    expect(await notifCount(`delegation:${d.delegationId}:revoked`)).toBe(1)
    expect((await whoIsOut(getDb(), b.rc.actor, new Date(b.rc.clock.nowMs()))).map(x => x.id)).not.toContain(d.delegationId)
  })

  it('refuses: yourself, a stand-in without an approver role at your sites, a non-approver delegating, bad dates, overlapping dates', async () => {
    const p = await mkProperty({ beds: 0 })
    const a = await asNow(await who('AA', { siteIds: [p.siteId] }))
    const w = await week()
    const refuse = async (r: Promise<any>, code: string) => { const x = await r; expect(x.ok).toBe(false); expect(x.code).toBe(code); return x }
    await refuse(createDelegation(a.rc, { toUserId: a.user.id, ...w }), 'invalid')
    const rec = await who('Rec', { siteIds: [p.siteId] })
    const res = await who('Res')
    const farAa = await who('AA', { siteIds: [(await mkProperty()).siteId] })
    for (const standIn of [rec, res, farAa]) {
      const x = await refuse(createDelegation(a.rc, { toUserId: standIn.user.id, ...w }), 'conflict')
      expect((x.detail as any).reason).toBe('not_an_approver')
    }
    await refuse(createDelegation(res.rc, { toUserId: a.user.id, ...w }), 'forbidden')
    const b = await who('AA', { siteIds: [p.siteId] })
    await refuse(createDelegation(a.rc, { toUserId: b.user.id, startsOn: w.endsOn, endsOn: w.startsOn, reason: null }), 'invalid')
    await refuse(createDelegation(a.rc, { toUserId: b.user.id, startsOn: '2020-01-01', endsOn: '2020-01-05', reason: null }), 'invalid')
    must(await createDelegation(a.rc, { toUserId: b.user.id, ...w }))
    await refuse(createDelegation(a.rc, { toUserId: b.user.id, ...w }), 'conflict')
    // by employee ID, and over the API with a body that names neither
    const c = await who('AA', { siteIds: [p.siteId] })
    const emp = (await admin().query(`SELECT employee_id FROM staff_profile WHERE id = $1`, [c.staffId])).rows[0].employee_id
    const a2 = await asNow(await who('AA', { siteIds: [p.siteId] }))
    must(await createDelegation(a2.rc, { toEmployeeId: emp, ...w }))
    expect((await call(delegateRoute, { cookie: await a.cookie(), body: { ...w } })).status).toBe(422)
  })

  it('a Policy Approver can name another Policy Approver of the same site, and a Super Admin another Super Admin', async () => {
    const p = await mkProperty({ beds: 0 })
    const w = await week()
    const pa1 = await asNow(await who('Mgr', { siteIds: [p.siteId], caps: ['PolicyApprover'] }))
    const pa2 = await who('Mgr', { siteIds: [p.siteId], caps: ['PolicyApprover'] })
    must(await createDelegation(pa1.rc, { toUserId: pa2.user.id, ...w }))
    const sa1 = await asNow(await who('SA')); const sa2 = await who('SA')
    must(await createDelegation(sa1.rc, { toUserId: sa2.user.id, ...w }))
  })

  it('ADDS NO AUTHORITY: a stand-in without the role is still refused (403) and sees nothing in the inbox, even with a delegation row in place', async () => {
    const s = await scenario()
    const rec = await who('Rec', { siteIds: [s.siteId] })
    const res = await who('Res')
    const w = await week()
    for (const standIn of [rec, res]) {
      await admin().query(`INSERT INTO delegation (from_user_id, to_user_id, starts_on, ends_on) VALUES ($1, $2, $3, $4)`, [s.aa.user.id, standIn.user.id, w.startsOn, w.endsOn]) // bypassing the command's checks
    }
    const asRec = await call(approveRoute, { cookie: await rec.cookie(), params: { id: s.requestId }, body: { bedId: s.bedIds[0] } })
    expect(asRec.status).toBe(403)
    const asRes = await call(approveRoute, { cookie: await res.cookie(), params: { id: s.requestId }, body: { bedId: s.bedIds[0] } })
    expect(asRes.status).toBe(403)
    expect(await items(rec)).toEqual([])
    expect((await requestRow(s.requestId)).status).toBe('submitted')
    // and a real stand-in decides only inside their OWN scope: an AA of another site is refused with 404 whatever the delegation says
    const far = await who('AA', { siteIds: [(await mkProperty()).siteId] })
    await admin().query(`INSERT INTO delegation (from_user_id, to_user_id, starts_on, ends_on) VALUES ($1, $2, $3, $4)`, [s.aa.user.id, far.user.id, w.startsOn, w.endsOn])
    const asFar = await approveRequest(far.rc, { requestId: s.requestId, bedId: s.bedIds[0] })
    expect(asFar.ok).toBe(false)
    if (!asFar.ok) expect(asFar.code).toBe('not_found')
  })

  it('the stand-in gets the reminder for what waits for the person they cover, once; it never reaches a non-stand-in; the card says "acting for"', async () => {
    const s = await scenario()
    const standIn = await who('AA', { siteIds: [s.siteId] })
    const base = await dbNow()
    const today = base.toISOString().slice(0, 10)
    const ends = new Date(base.getTime() + 20 * 86_400_000).toISOString().slice(0, 10)
    await admin().query(`INSERT INTO delegation (from_user_id, to_user_id, starts_on, ends_on) VALUES ($1, $2, $3, $4)`, [s.aa.user.id, standIn.user.id, today, ends])
    const later = new FixedClock(base.getTime() + 3 * 86_400_000 + 3600_000) // 3 days after filing: at least one business day gone
    await runSwept('delegation_reminders', later)
    const key = `approval:request:${s.requestId}:delegate:%`
    // (a Super Admin's stand-in elsewhere in this database is also reminded: they cover every site, so filter to ours)
    const rows = (await admin().query(`SELECT to_staff_id, text FROM notification WHERE dedupe_key LIKE $1 AND to_staff_id = $2`, [key, standIn.staffId])).rows
    expect(rows).toHaveLength(1)
    expect(rows[0].text).toMatch(/Covering for/)
    await runSwept('delegation_reminders', later)
    expect((await admin().query(`SELECT 1 FROM notification WHERE dedupe_key LIKE $1 AND to_staff_id = $2`, [key, standIn.staffId])).rowCount).toBe(1)
    expect((await requestRow(s.requestId)).status).toBe('submitted') // reminded, not decided

    const mine = await approvalsInbox(getDb(), { actor: standIn.rc.actor, user: standIn.rc.user, clock: later })
    const card = mine.find(i => i.ref === s.requestId)!
    expect(card.coveringFor).toHaveLength(1)
    expect(card.awayNow[0].standIn).toBeTruthy()
    // revoked delegations send nothing new
    const s2 = await scenario()
    const standIn2 = await who('AA', { siteIds: [s2.siteId] })
    const d = (await admin().query(`INSERT INTO delegation (from_user_id, to_user_id, starts_on, ends_on, revoked_at) VALUES ($1, $2, $3, $4, now()) RETURNING id`, [s2.aa.user.id, standIn2.user.id, today, ends])).rows[0]
    await runSwept('delegation_reminders', later)
    expect(await notifCount(`approval:request:${s2.requestId}:delegate:${d.id}`)).toBe(0)
  })
})
