import { afterAll, describe, expect, it } from 'vitest'
import { admin, closeAll } from '../harness'
import { mkBed, mkProperty, mkRoom, mkStaff, reserve, occupy } from '../fixtures2'
import { auditCount, send } from '../property/helpers'
import { initiateEmergency } from '@/server/commands/emergency/initiate'
import { POST as initiateRoute, GET as listRoute } from '../../../app/api/v1/emergency/route'
import { GET as findPersonRoute } from '../../../app/api/v1/emergency/staff/route'
import { GET as bedsRoute } from '../../../app/api/v1/emergency/beds/route'
import { T0, HOUR, auditFor, bedState, caseRow, claimOf, clockAt, notifs, stayRow, who, world } from './helpers'

afterAll(closeAll)

describe('initiate an emergency check-in (D-66 to D-68)', () => {
  it('gives the person a bed at once as a PROVISIONAL stay, opens the case, audits and notifies the approver role', async () => {
    const w = await world()
    const p = await mkStaff()
    const clock = clockAt(0)
    const r = await initiateEmergency(w.rec.rc(clock), { staffId: p.id, bedId: w.bedIds[0], reason: 'Fire alarm in block D' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data).toMatchObject({ status: 'pending', stayStatus: 'provisional', approverRoute: 'AA', bedId: w.bedIds[0] })

    const stay = await stayRow(r.data.stayId)
    expect(stay).toMatchObject({ status: 'provisional', source: 'provisional', reservation_id: null, staff_id: p.id, bed_id: w.bedIds[0] })
    expect(await bedState(w.bedIds[0])).toBe('occupied')
    const claim = await claimOf(r.data.stayId)
    expect(claim).toMatchObject({ kind: 'stay', released_at: null })

    const c = await caseRow(r.data.caseId)
    expect(c).toMatchObject({
      status: 'pending', approver_route: 'AA', initiated_by: w.rec.user.id, initiated_by_role: 'Rec', initiated_by_staff_id: w.rec.user.staffId,
      reminders: 0, escalation: 0, reason: 'Fire alarm in block D', site_id: w.siteId, decided_by: null,
    })
    expect(c.deadline_at.getTime()).toBe(T0.getTime() + 24 * HOUR)
    expect(c.created_at.getTime()).toBe(T0.getTime())

    const audit = await auditFor(r.data.caseId)
    expect(audit.map(a => a.action)).toEqual(['emergency.initiated'])
    expect(audit[0]).toMatchObject({ actor_user_id: w.rec.user.id, actor_role: 'Rec' })
    expect(audit[0].after).toMatchObject({ status: 'pending', stayStatus: 'provisional', approverRoute: 'AA' })

    const n = await notifs(r.data.caseId)
    expect(n).toEqual([expect.objectContaining({ dedupe_key: `emergency:${r.data.caseId}:initiated`, to_role: 'AA', kind: 'emergency.pending' })])
  })

  it('an AA initiator routes the decision to a Policy Approver (D-68)', async () => {
    const w = await world()
    const p = await mkStaff()
    const r = await initiateEmergency(w.aaInit.rc(clockAt(0)), { staffId: p.id, bedId: w.bedIds[0], reason: 'Burst pipe in the staff block' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.approverRoute).toBe('PA')
    expect((await caseRow(r.data.caseId)).initiated_by_role).toBe('AA')
    expect((await notifs(r.data.caseId))[0]).toMatchObject({ to_role: 'PolicyApprover' })
  })

  it('only holders of the Emergency Check-in capability can initiate: 403 for everyone else, whatever their role', async () => {
    const w = await world()
    const p = await mkStaff()
    const body = { staffId: p.id, bedId: w.bedIds[0], reason: 'Flood in the lobby' }
    for (const who_ of [w.aa, w.pa, w.backup, w.sa, await who('Rec', { siteIds: [w.siteId] })]) {
      const r = await send(initiateRoute, who_, { body })
      expect(r.status, `${who_.role}`).toBe(403)
    }
    expect((await admin().query(`SELECT 1 FROM emergency_checkin WHERE staff_id = $1`, [p.id])).rowCount).toBe(0)
    const ok = await send(initiateRoute, w.rec, { body })
    expect(ok.status).toBe(200)
    expect(ok.body.data).toMatchObject({ status: 'pending', stayStatus: 'provisional' })
  })

  it('a validation failure names the field; a reason is mandatory', async () => {
    const w = await world()
    const p = await mkStaff()
    const r = await send(initiateRoute, w.rec, { body: { staffId: p.id, bedId: w.bedIds[0], reason: '  ' } })
    expect(r.status).toBe(422)
    expect(r.body.fields.reason).toBeTruthy()
  })

  it('refuses a person who already has a stay, who has left, who is the initiator, or who does not exist', async () => {
    const w = await world()
    const reason = 'Smoke in the corridor'
    const occupied = await occupy(w.bedIds[5])
    const r1 = await initiateEmergency(w.rec.rc(clockAt(0)), { staffId: occupied.staffId, bedId: w.bedIds[0], reason })
    expect(r1).toMatchObject({ ok: false, code: 'conflict', detail: { reason: 'has_stay' } })
    if (!r1.ok) expect(r1.owner && r1.next).toBeTruthy()

    const left = await mkStaff({ status: 'left' })
    expect(await initiateEmergency(w.rec.rc(clockAt(0)), { staffId: left.id, bedId: w.bedIds[0], reason })).toMatchObject({ ok: false, code: 'conflict' })

    const self = await initiateEmergency(w.rec.rc(clockAt(0)), { staffId: w.rec.user.staffId, bedId: w.bedIds[0], reason })
    expect(self).toMatchObject({ ok: false, code: 'separation_of_duties' })

    const nobody = await initiateEmergency(w.rec.rc(clockAt(0)), { staffId: crypto.randomUUID(), bedId: w.bedIds[0], reason })
    expect(nobody).toMatchObject({ ok: false, code: 'invalid' })
    expect(await bedState(w.bedIds[0])).toBe('available')
  })

  it('a bed in another site is "not found" for an initiator of this site (scope)', async () => {
    const w = await world(1)
    const other = await mkProperty({ beds: 1 })
    const p = await mkStaff()
    const r = await send(initiateRoute, w.rec, { body: { staffId: p.id, bedId: other.bedIds[0], reason: 'Fire in the other site' } })
    expect(r.status).toBe(404)
    expect(await bedState(other.bedIds[0])).toBe('available')
  })

  it('a bed that is occupied, not ready, blocked or booked is refused with reason, owner and next action; nothing is left half done', async () => {
    const w = await world(2)
    const before = await auditCount(w.siteId)
    const dirtyBed = await mkBed(w.roomId, { state: 'needs_cleaning' })
    const blockedBed = await mkBed(w.roomId, { state: 'blocked' })
    await occupy(w.bedIds[0])
    await reserve(w.bedIds[1], '2026-10-14', '2026-10-20')
    const run = async (bedId: string) => initiateEmergency(w.rec.rc(clockAt(0)), { staffId: (await mkStaff()).id, bedId, reason: 'Evacuation of block D' })
    const [occ, dirty, blocked, booked] = [await run(w.bedIds[0]), await run(dirtyBed), await run(blockedBed), await run(w.bedIds[1])]
    expect(occ).toMatchObject({ ok: false, code: 'conflict', detail: { reason: 'bed_taken' } })
    expect(dirty).toMatchObject({ ok: false, code: 'conflict', detail: { reason: 'bed_not_ready' } })
    expect(blocked).toMatchObject({ ok: false, code: 'conflict', detail: { reason: 'bed_unavailable' } })
    expect(booked).toMatchObject({ ok: false, code: 'conflict', detail: { reason: 'bed_taken' } })
    for (const r of [occ, dirty, blocked, booked]) if (!r.ok) { expect(r.owner).toBeTruthy(); expect(r.next).toBeTruthy() }
    expect(await bedState(dirtyBed)).toBe('needs_cleaning')
    expect(await auditCount(w.siteId)).toBe(before)
    expect((await admin().query(`SELECT 1 FROM emergency_checkin WHERE site_id = $1`, [w.siteId])).rowCount).toBe(0)
  })

  it('a booking that starts later does not stop a short emergency stay before it', async () => {
    const w = await world(1)
    await reserve(w.bedIds[0], '2026-10-20', '2026-10-30')
    const ok = await initiateEmergency(w.rec.rc(clockAt(0)), { staffId: (await mkStaff()).id, bedId: w.bedIds[0], reason: 'One night only', expectedDays: 3 })
    expect(ok.ok).toBe(true)
    const w2 = await world(1)
    await reserve(w2.bedIds[0], '2026-10-20', '2026-10-30')
    const tooLong = await initiateEmergency(w2.rec.rc(clockAt(0)), { staffId: (await mkStaff()).id, bedId: w2.bedIds[0], reason: 'Open ended', expectedDays: null })
    expect(tooLong).toMatchObject({ ok: false, detail: { reason: 'bed_taken' } })
  })

  it('eligibility is the approver\'s call: a rule that would fail is recorded on the case, and the stay is still created', async () => {
    const w = await world(0)
    const room = await mkRoom(w.siteId, { gender: 'female' })
    const bedId = await mkBed(room)
    const man = await mkStaff({ gender: 'male' })
    const r = await initiateEmergency(w.rec.rc(clockAt(0)), { staffId: man.id, bedId, reason: 'Only free bed after the flood' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.eligibility).toMatchObject({ ok: false, failed: ['gender'] })
    const c = await caseRow(r.data.caseId)
    expect(c.eligibility_flags).toMatchObject({ ok: false, failed: ['gender'] })
    expect((await notifs(r.data.caseId))[0].text).toContain('would have failed')
  })

  it('two initiations for the same bed: exactly one wins, the other is told the bed is taken', async () => {
    const w = await world(1)
    const [a, b] = await Promise.all([
      initiateEmergency(w.rec.rc(clockAt(0)), { staffId: (await mkStaff()).id, bedId: w.bedIds[0], reason: 'Alarm one' }),
      initiateEmergency(w.aaInit.rc(clockAt(0)), { staffId: (await mkStaff()).id, bedId: w.bedIds[0], reason: 'Alarm two' }),
    ])
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1)
    const loser = a.ok ? b : a
    expect(loser).toMatchObject({ ok: false, code: 'conflict' })
    expect((await admin().query(`SELECT 1 FROM stay WHERE bed_id = $1`, [w.bedIds[0]])).rowCount).toBe(1)
    expect((await admin().query(`SELECT 1 FROM emergency_checkin WHERE bed_id = $1`, [w.bedIds[0]])).rowCount).toBe(1)
  })

  it('two initiations for the same person in different beds: exactly one wins', async () => {
    const w = await world(2)
    const p = await mkStaff()
    const [a, b] = await Promise.all([
      initiateEmergency(w.rec.rc(clockAt(0)), { staffId: p.id, bedId: w.bedIds[0], reason: 'Alarm one' }),
      initiateEmergency(w.aaInit.rc(clockAt(0)), { staffId: p.id, bedId: w.bedIds[1], reason: 'Alarm two' }),
    ])
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1)
    expect((await admin().query(`SELECT 1 FROM stay WHERE staff_id = $1`, [p.id])).rowCount).toBe(1)
  })
})

describe('what the initiate form reads', () => {
  it('finds a person by employee ID (minimum fields) and lists free beds in the initiator\'s sites only', async () => {
    const w = await world(3)
    const other = await mkProperty({ beds: 2 })
    const p = await mkStaff()
    const found = await send(findPersonRoute, w.rec, { path: `/api/v1/emergency/staff?employeeId=${p.employeeId.toLowerCase()}` })
    expect(found.status).toBe(200)
    expect(found.body.data).toMatchObject({ id: p.id, fullName: expect.any(String), hasStay: false, isSelf: false })
    expect(Object.keys(found.body.data).sort()).toEqual(['department', 'employeeId', 'employmentStatus', 'fullName', 'hasStay', 'id', 'isSelf'])
    expect((await send(findPersonRoute, w.rec, { path: '/api/v1/emergency/staff?employeeId=NOPE-1' })).status).toBe(404)
    expect((await send(findPersonRoute, w.aa, { path: `/api/v1/emergency/staff?employeeId=${p.employeeId}` })).status).toBe(403)

    await occupy(w.bedIds[0])
    const beds = await send(bedsRoute, w.rec, { path: '/api/v1/emergency/beds' })
    expect(beds.status).toBe(200)
    const ids = (beds.body.data as { id: string }[]).map(b => b.id)
    expect(ids).toEqual(expect.arrayContaining([w.bedIds[1], w.bedIds[2]]))
    expect(ids).not.toContain(w.bedIds[0])
    for (const b of other.bedIds) expect(ids).not.toContain(b)
  })

  it('the list shows an initiator their own cases and nobody else\'s', async () => {
    const w = await world(2)
    const mine = await (async () => { const p = await mkStaff(); const r = await initiateEmergency(w.rec.rc(clockAt(0)), { staffId: p.id, bedId: w.bedIds[0], reason: 'Mine' }); return r.ok ? r.data.caseId : '' })()
    const theirs = await (async () => { const p = await mkStaff(); const r = await initiateEmergency(w.aaInit.rc(clockAt(0)), { staffId: p.id, bedId: w.bedIds[1], reason: 'Theirs' }); return r.ok ? r.data.caseId : '' })()
    const recList = await send(listRoute, w.rec)
    const recIds = (recList.body.data.items as { id: string }[]).map(i => i.id)
    expect(recIds).toContain(mine)
    expect(recIds).not.toContain(theirs)
    const aaList = await send(listRoute, w.aa)
    expect((aaList.body.data.items as { id: string }[]).map(i => i.id)).toEqual(expect.arrayContaining([mine, theirs]))
    // a resident, or an AA of another site, sees nothing
    const stranger = await who('AA', { siteIds: [(await mkProperty({ beds: 0 })).siteId] })
    expect((await send(listRoute, stranger)).body.data.items.map((i: { id: string }) => i.id)).not.toContain(mine)
    expect((await send(listRoute, await who('Res'))).status).toBe(403)
  })
})
