import { afterAll, describe, expect, it } from 'vitest'
import { admin, closeAll } from '../harness'
import { mkBed, mkProperty, mkRoom, mkStaff } from '../fixtures2'
import { send } from '../property/helpers'
import { getDb } from '@/server/db/client'
import { approveEmergency, rejectEmergency } from '@/server/commands/emergency/decide'
import { completeTask } from '@/server/commands/emergency/completeTask'
import { convertEmergencyForExit } from '@/server/commands/emergency/convertForExit'
import { initiateEmergency } from '@/server/commands/emergency/initiate'
import { emergencyReminders, relocationOverdue } from '@/server/jobs/sweeps/emergency'
import { GET as getRoute } from '../../../app/api/v1/emergency/[id]/route'
import { POST as approveRoute } from '../../../app/api/v1/emergency/[id]/approve/route'
import { POST as rejectRoute } from '../../../app/api/v1/emergency/[id]/reject/route'
import { GET as tasksRoute } from '../../../app/api/v1/emergency/tasks/route'
import { POST as completeRoute } from '../../../app/api/v1/emergency/tasks/[id]/complete/route'
import { HOUR, T0, auditFor, bedState, caseRow, checkOutByHand, claimOf, clockAt, notifs, stayRow, start, sweepCtx, taskFor, who, world } from './helpers'

afterAll(closeAll)

describe('AT-017: the initiator can never approve (D-26)', () => {
  it('an AA who started the stay is refused, nothing changes, and the refusal is audited although the command rolled back', async () => {
    const w = await world()
    const e = await start(w, { by: w.aaInit })
    const r = await approveEmergency(w.aaInit.rc(clockAt(1)), { caseId: e.caseId })
    expect(r).toMatchObject({ ok: false, code: 'separation_of_duties', status: 403 })
    if (!r.ok) { expect(r.reason).toMatch(/started this emergency check-in/); expect(r.owner).toBeTruthy(); expect(r.next).toBeTruthy() }

    expect(await caseRow(e.caseId)).toMatchObject({ status: 'pending', decided_by: null })
    expect(await stayRow(e.stayId)).toMatchObject({ status: 'provisional' })

    const audit = await auditFor(e.caseId)
    expect(audit.map(a => a.action)).toEqual(['emergency.initiated', 'emergency.decision_refused'])
    expect(audit[1]).toMatchObject({ actor_user_id: w.aaInit.user.id, actor_role: 'AA' })
    expect(audit[1].after).toMatchObject({ attempted: 'approve', outcome: 'refused' })

    // rejecting your own is refused just the same
    expect(await rejectEmergency(w.aaInit.rc(clockAt(1)), { caseId: e.caseId, reason: 'Changed my mind' })).toMatchObject({ ok: false, code: 'separation_of_duties' })
    expect((await auditFor(e.caseId)).map(a => a.action)).toEqual(['emergency.initiated', 'emergency.decision_refused', 'emergency.decision_refused'])
  })

  it('through the API: 403 separation_of_duties, with reason, owner and next action', async () => {
    const w = await world()
    const e = await start(w, { by: w.aaInit })
    const r = await send(approveRoute, w.aaInit, { id: e.caseId, body: {} })
    expect(r.status).toBe(403)
    expect(r.body).toMatchObject({ ok: false, code: 'separation_of_duties' })
    expect(r.body.owner).toBeTruthy()
    expect(r.body.next).toBeTruthy()
    expect((await auditFor(e.caseId)).map(a => a.action)).toContain('emergency.decision_refused')
  })

  it('a Reception initiator who also holds an approval standing is refused as the initiator; the refusal is audited', async () => {
    const w = await world()
    const e = await start(w)
    const r = await approveEmergency(w.rec.rc(clockAt(1)), { caseId: e.caseId })
    expect(r).toMatchObject({ ok: false, code: 'separation_of_duties' })
    expect((await auditFor(e.caseId)).map(a => a.action)).toContain('emergency.decision_refused')
    expect(await caseRow(e.caseId)).toMatchObject({ status: 'pending' })
  })

  it('the person the stay is for cannot decide it either', async () => {
    const w = await world()
    const aaResident = await who('AA', { siteIds: [w.siteId] })
    const e = await start(w, { staffId: aaResident.user.staffId })
    const r = await approveEmergency(aaResident.rc(clockAt(1)), { caseId: e.caseId })
    expect(r).toMatchObject({ ok: false, code: 'separation_of_duties' })
    const refused = (await auditFor(e.caseId)).find(a => a.action === 'emergency.decision_refused')
    expect(refused?.reason).toMatch(/person the stay is for/)
  })

  it('an AA-initiated case cannot be approved by another AA: only a Policy Approver (or, once escalated, the backup)', async () => {
    const w = await world()
    const e = await start(w, { by: w.aaInit })
    const r = await approveEmergency(w.aa.rc(clockAt(2)), { caseId: e.caseId })
    expect(r).toMatchObject({ ok: false, code: 'forbidden' })
    if (!r.ok) { expect(r.reason).toMatch(/started this emergency check-in|goes to a Policy Approver/); expect(r.owner).toBe('Policy Approver'); expect(r.next).toBeTruthy() }
    expect(await caseRow(e.caseId)).toMatchObject({ status: 'pending' })
    // the backup approver is not on the route before the first escalation
    expect(await approveEmergency(w.backup.rc(clockAt(2)), { caseId: e.caseId })).toMatchObject({ ok: false, code: 'forbidden' })

    const ok = await approveEmergency(w.pa.rc(clockAt(3)), { caseId: e.caseId })
    expect(ok).toMatchObject({ ok: true, data: { status: 'approved', stayStatus: 'active', decidedVia: 'PolicyApprover' } })
  })
})

describe('approve', () => {
  it('an independent AA approves a Reception-initiated stay: Provisional becomes Active, with actor, time and before/after in the audit', async () => {
    const w = await world()
    const e = await start(w)
    const r = await approveEmergency(w.aa.rc(clockAt(5)), { caseId: e.caseId, note: 'Confirmed with the duty manager' })
    expect(r).toMatchObject({ ok: true, data: { status: 'approved', stayStatus: 'active', decidedVia: 'AA' } })
    expect(await stayRow(e.stayId)).toMatchObject({ status: 'active', source: 'provisional' })
    expect(await bedState(e.bedId)).toBe('occupied')
    expect(await claimOf(e.stayId)).toMatchObject({ kind: 'stay', released_at: null })
    const c = await caseRow(e.caseId)
    expect(c).toMatchObject({ status: 'approved', decided_by: w.aa.user.id, decided_by_role: 'AA', decided_via: 'AA', decision_note: 'Confirmed with the duty manager' })
    expect(c.decided_at.getTime()).toBe(T0.getTime() + 5 * HOUR)
    const a = (await auditFor(e.caseId)).find(x => x.action === 'emergency.approved')!
    expect(a).toMatchObject({ actor_user_id: w.aa.user.id, actor_role: 'AA' })
    expect(a.before).toMatchObject({ status: 'pending', stayStatus: 'provisional' })
    expect(a.after).toMatchObject({ status: 'approved', stayStatus: 'active', residentMoved: false })
    expect((await notifs(e.caseId)).find(n => n.kind === 'emergency.approved')).toMatchObject({ to_staff_id: w.rec.user.staffId })
  })

  it('a second decision on a decided case is a conflict that says who decided', async () => {
    const w = await world()
    const e = await start(w)
    await approveEmergency(w.aa.rc(clockAt(5)), { caseId: e.caseId })
    expect(await approveEmergency(w.aa.rc(clockAt(6)), { caseId: e.caseId })).toMatchObject({ ok: false, code: 'conflict', detail: { reason: 'already_decided', status: 'approved' } })
    expect(await rejectEmergency(w.aa.rc(clockAt(6)), { caseId: e.caseId, reason: 'Too late' })).toMatchObject({ ok: false, code: 'conflict' })
    expect(await stayRow(e.stayId)).toMatchObject({ status: 'active' })
  })

  it('two decisions at once on one case: exactly one wins', async () => {
    const w = await world()
    const e = await start(w)
    const other = await who('AA', { siteIds: [w.siteId] })
    const [a, b] = await Promise.all([
      approveEmergency(w.aa.rc(clockAt(5)), { caseId: e.caseId }),
      rejectEmergency(other.rc(clockAt(5)), { caseId: e.caseId, reason: 'Not needed any more' }),
    ])
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1)
    const c = await caseRow(e.caseId)
    expect(['approved', 'rejected']).toContain(c.status)
    expect((await taskFor(e.caseId)).length).toBe(c.status === 'rejected' ? 1 : 0)
  })

  it('when a rule would have failed the approver must say why they accept it; the decision keeps the rules it saw', async () => {
    const w = await world(0)
    const room = await mkRoom(w.siteId, { gender: 'female' })
    const bedId = await mkBed(room)
    const man = await mkStaff({ gender: 'male' })
    const r0 = await initiateEmergency(w.rec.rc(clockAt(0)), { staffId: man.id, bedId, reason: 'Only free bed' })
    if (!r0.ok) throw new Error(r0.reason)
    const refused = await approveEmergency(w.aa.rc(clockAt(1)), { caseId: r0.data.caseId })
    expect(refused).toMatchObject({ ok: false, code: 'invalid' })
    if (!refused.ok) expect(refused.fields?.note).toMatch(/female-only/)
    expect(await caseRow(r0.data.caseId)).toMatchObject({ status: 'pending' })
    const ok = await approveEmergency(w.aa.rc(clockAt(1)), { caseId: r0.data.caseId, note: 'Temporary, moves tomorrow' })
    expect(ok.ok).toBe(true)
    expect((await caseRow(r0.data.caseId)).decision_flags).toMatchObject({ ok: false, failed: ['gender'] })
  })

  it('a stay that is no longer provisional (checked out by a person) cannot be approved', async () => {
    const w = await world()
    const e = await start(w)
    await checkOutByHand(e.stayId)
    expect(await approveEmergency(w.aa.rc(clockAt(2)), { caseId: e.caseId })).toMatchObject({ ok: false, code: 'conflict', detail: { reason: 'stay_changed' } })
  })

  it('scope: an AA of another site gets 404 for the case and for every decision; an AA of this site sees it', async () => {
    const w = await world()
    const e = await start(w)
    const elsewhere = await who('AA', { siteIds: [(await mkProperty({ beds: 0 })).siteId] })
    expect((await send(getRoute, elsewhere, { id: e.caseId })).status).toBe(404)
    expect((await send(approveRoute, elsewhere, { id: e.caseId, body: {} })).status).toBe(404)
    expect((await send(rejectRoute, elsewhere, { id: e.caseId, body: { reason: 'Nope, not ours' } })).status).toBe(404)
    expect(await caseRow(e.caseId)).toMatchObject({ status: 'pending' })
    const seen = await send(getRoute, w.aa, { id: e.caseId })
    expect(seen.status).toBe(200)
    expect(seen.body.data.item).toMatchObject({ id: e.caseId, status: 'pending', stayStatus: 'provisional', me: { canDecide: true, via: 'AA' } })
    // the initiator sees "why you can't approve"
    const mine = await send(getRoute, w.rec, { id: e.caseId })
    expect(mine.body.data.item.me).toMatchObject({ canDecide: false, kind: 'initiator' })
    expect(mine.body.data.item.me.why).toBeTruthy()
    // a guessed id of a case that does not exist is the same 404
    expect((await send(getRoute, w.aa, { id: crypto.randomUUID() })).status).toBe(404)
  })
})

describe('AT-018: rejection', () => {
  it('needs a reason; with one the stay is Resolution pending, the AA gets a task with a deadline, and the resident is NOT moved', async () => {
    const w = await world()
    const e = await start(w)
    const noReason = await send(rejectRoute, w.aa, { id: e.caseId, body: { reason: '   ' } })
    expect(noReason.status).toBe(422)
    expect(noReason.body.fields.reason).toBeTruthy()
    expect(await rejectEmergency(w.aa.rc(clockAt(5)), { caseId: e.caseId, reason: '' })).toMatchObject({ ok: false, code: 'invalid' })
    expect(await caseRow(e.caseId)).toMatchObject({ status: 'pending' })
    expect(await taskFor(e.caseId)).toHaveLength(0)

    const r = await rejectEmergency(w.aa.rc(clockAt(5)), { caseId: e.caseId, reason: 'Rooms for flood evacuees were found in block C' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data).toMatchObject({ status: 'rejected', stayStatus: 'resolution_pending', task: { ownerRole: 'AA' } })

    // the resident is exactly where they were
    expect(await stayRow(e.stayId)).toMatchObject({ status: 'resolution_pending', bed_id: e.bedId, checked_out_at: null })
    expect(await bedState(e.bedId)).toBe('occupied')
    expect(await claimOf(e.stayId)).toMatchObject({ kind: 'stay', released_at: null })

    const c = await caseRow(e.caseId)
    expect(c).toMatchObject({ status: 'rejected', decision_note: 'Rooms for flood evacuees were found in block C', decided_by: w.aa.user.id })
    const [t] = await taskFor(e.caseId)
    expect(t).toMatchObject({ owner_role: 'AA', site_id: w.siteId, done_at: null })
    expect(t.due_at.getTime()).toBe(T0.getTime() + 5 * HOUR + 48 * HOUR) // timers.emergency_relocation_hours (GH-07, configurable)
    expect(t.title).toContain('Relocate or check out')

    const a = (await auditFor(e.caseId)).find(x => x.action === 'emergency.rejected')!
    expect(a).toMatchObject({ actor_user_id: w.aa.user.id, reason: 'Rooms for flood evacuees were found in block C' })
    expect(a.after).toMatchObject({ status: 'rejected', stayStatus: 'resolution_pending', residentMoved: false, taskId: t.id })
    expect((await notifs(e.caseId)).map(n => n.kind)).toEqual(expect.arrayContaining(['emergency.relocation_task', 'emergency.rejected']))

    // the task is listed for the AA, with the stay to act on
    const list = await send(tasksRoute, w.aa)
    const row = (list.body.data as { id: string; stayId: string; stayStatus: string }[]).find(x => x.id === t.id)
    expect(row).toMatchObject({ stayId: e.stayId, stayStatus: 'resolution_pending' })
  })

  it('a task is done by a person, and only once the resident has been dealt with', async () => {
    const w = await world()
    const e = await start(w)
    const rej = await rejectEmergency(w.aa.rc(clockAt(5)), { caseId: e.caseId, reason: 'Not an emergency after all' })
    if (!rej.ok) throw new Error(rej.reason)
    const taskId = rej.data.task!.id

    expect(await completeTask(w.aa.rc(clockAt(6)), { taskId, note: '' })).toMatchObject({ ok: false, code: 'invalid' })
    const early = await completeTask(w.aa.rc(clockAt(6)), { taskId, note: 'Moved to block C' })
    expect(early).toMatchObject({ ok: false, code: 'conflict', detail: { reason: 'resident_still_in_bed' } })
    if (!early.ok) expect(early.owner && early.next).toBeTruthy()
    expect((await taskFor(e.caseId))[0].done_at).toBeNull()

    expect((await send(completeRoute, w.rec, { id: taskId, body: { note: 'Moved to block C' } })).status).toBe(403)
    await checkOutByHand(e.stayId)
    const done = await send(completeRoute, w.aa, { id: taskId, body: { note: 'Checked out and moved to block C' } })
    expect(done.status).toBe(200)
    const [t] = await taskFor(e.caseId)
    expect(t).toMatchObject({ done_by: w.aa.user.id, done_note: 'Checked out and moved to block C' })
    expect(await completeTask(w.aa.rc(clockAt(7)), { taskId, note: 'Again' })).toMatchObject({ ok: false, code: 'conflict' })
    expect((await auditFor(taskId)).map(a => a.action)).toEqual(['emergency.task_completed'])
  })

  it('a task of another site is not found for an AA elsewhere', async () => {
    const w = await world()
    const e = await start(w)
    const rej = await rejectEmergency(w.aa.rc(clockAt(5)), { caseId: e.caseId, reason: 'Not needed' })
    if (!rej.ok) throw new Error(rej.reason)
    const elsewhere = await who('AA', { siteIds: [(await mkProperty({ beds: 0 })).siteId] })
    expect((await send(completeRoute, elsewhere, { id: rej.data.task!.id, body: { note: 'Not mine to close' } })).status).toBe(404)
    const list = await send(tasksRoute, elsewhere)
    expect((list.body.data as { id: string }[]).map(t => t.id)).not.toContain(rej.data.task!.id)
  })

  it('an overdue task alerts the owner and the Policy Approver once; the resident is still not moved', async () => {
    const w = await world()
    const e = await start(w)
    const rej = await rejectEmergency(w.aa.rc(clockAt(5)), { caseId: e.caseId, reason: 'Not needed' })
    if (!rej.ok) throw new Error(rej.reason)
    const taskId = rej.data.task!.id
    const due = 5 + 48
    await relocationOverdue(sweepCtx(clockAt(due - 0.001)), [taskId])
    const keys = async () => (await admin().query<{ dedupe_key: string }>(`SELECT dedupe_key FROM notification WHERE dedupe_key LIKE $1`, [`task:${taskId}:%`])).rows.map(r => r.dedupe_key).sort()
    expect(await keys()).toEqual([])
    const first = await relocationOverdue(sweepCtx(clockAt(due)), [taskId])
    expect(first).toMatchObject({ alerted: 1 })
    expect(await keys()).toEqual([`task:${taskId}:overdue_owner`, `task:${taskId}:overdue_policy`])
    expect(await relocationOverdue(sweepCtx(clockAt(due + 30)), [taskId])).toMatchObject({ alerted: 0 })
    expect(await stayRow(e.stayId)).toMatchObject({ status: 'resolution_pending', checked_out_at: null })
    expect(await bedState(e.bedId)).toBe('occupied')
  })
})

describe('escalated approvers (D-68)', () => {
  it('the backup approver and the Policy Approver may decide a Reception-initiated case from the first escalation, not before', async () => {
    const w = await world()
    const e = await start(w)
    expect(await approveEmergency(w.backup.rc(clockAt(30)), { caseId: e.caseId })).toMatchObject({ ok: false, code: 'forbidden' })
    expect(await approveEmergency(w.pa.rc(clockAt(30)), { caseId: e.caseId })).toMatchObject({ ok: false, code: 'forbidden' })
    await emergencyReminders(sweepCtx(clockAt(48)), [e.caseId])
    expect(await caseRow(e.caseId)).toMatchObject({ escalation: 1, reminders: 2, status: 'pending' })
    const ok = await approveEmergency(w.backup.rc(clockAt(49)), { caseId: e.caseId, note: 'Approved as authorised backup' })
    expect(ok).toMatchObject({ ok: true, data: { decidedVia: 'BackupApprover' } })
    expect(await caseRow(e.caseId)).toMatchObject({ decided_via: 'BackupApprover' })
  })

  it('a Super Admin is told at the last level but decides nothing without a capability (the matrix gives SA configuration only)', async () => {
    const w = await world()
    const e = await start(w)
    await emergencyReminders(sweepCtx(clockAt(72)), [e.caseId])
    const r = await approveEmergency(w.sa.rc(clockAt(73)), { caseId: e.caseId })
    expect(r).toMatchObject({ ok: false, code: 'forbidden' })
  })
})

describe('Mark as Left converts a pending emergency (D-36)', () => {
  it('closes the approval question, touches neither the stay nor the bed, and stops the reminders', async () => {
    const w = await world()
    const e = await start(w)
    const converted = await getDb().transaction(tx => convertEmergencyForExit(tx, e.staffId, { now: clockAt(10).now(), userId: w.aa.user.id, role: 'AA' }, { clearanceCaseId: 'CL-1' }))
    expect(converted).toEqual([{ caseId: e.caseId, stayId: e.stayId, siteId: w.siteId }])
    expect(await caseRow(e.caseId)).toMatchObject({ status: 'converted' })
    expect(await stayRow(e.stayId)).toMatchObject({ status: 'provisional' })
    expect(await bedState(e.bedId)).toBe('occupied')
    expect((await auditFor(e.caseId)).map(a => a.action)).toContain('emergency.converted_for_exit')
    // nothing left to approve, remind or escalate
    expect(await approveEmergency(w.aa.rc(clockAt(11)), { caseId: e.caseId })).toMatchObject({ ok: false, code: 'conflict' })
    await emergencyReminders(sweepCtx(clockAt(100)), [e.caseId])
    expect(await caseRow(e.caseId)).toMatchObject({ reminders: 0, escalation: 0 })
    // calling it again finds nothing
    expect(await getDb().transaction(tx => convertEmergencyForExit(tx, e.staffId, { now: clockAt(12).now() }))).toEqual([])
  })
})

describe('database guards', () => {
  it('the database itself refuses a decision by the initiator and a rejection without a reason', async () => {
    const w = await world()
    const e = await start(w)
    await expect(admin().query(`UPDATE emergency_checkin SET status = 'approved', decided_by = initiated_by, decided_at = now(), decided_via = 'AA' WHERE id = $1`, [e.caseId])).rejects.toThrow(/emergency_initiator_not_approver/)
    await expect(admin().query(`UPDATE emergency_checkin SET status = 'rejected', decided_by = $2, decided_at = now(), decided_via = 'AA' WHERE id = $1`, [e.caseId, w.aa.user.id])).rejects.toThrow(/emergency_rejection_reason/)
    await approveEmergency(w.aa.rc(clockAt(1)), { caseId: e.caseId })
    await expect(admin().query(`UPDATE emergency_checkin SET status = 'pending', decided_by = NULL, decided_at = NULL, decided_via = NULL WHERE id = $1`, [e.caseId])).rejects.toThrow(/illegal emergency_checkin.status transition/)
  })
})
