import { afterAll, describe, expect, it } from 'vitest'
import { admin, closeAll, grantCapability, makeUser } from '../harness'
import { auditActions, bedRow, cleaningTasks, FULL, housekeeper, inspector, mkStay, mkStaff, notificationsByKey, scene, setBedState, taskRow, vacate, day } from './helpers'
import { assignCleaning, cancelTask } from '@/server/commands/readiness/assign'
import { completeCleaning } from '@/server/commands/readiness/clean'
import { failInspection, passInspection } from '@/server/commands/readiness/inspect'
import { person } from '../stays/helpers'
import { rcFor } from '../rc'

afterAll(closeAll)

/** A scene with one vacated bed (real checkout) and its open task. */
async function vacated() {
  const s = await scene({ beds: 3 })
  const v = await vacate(s, s.bedIds[0])
  return { ...s, ...v, bedId: s.bedIds[0] }
}
type V = Awaited<ReturnType<typeof vacated>>
const assign = (v: V, staffId = v.hk.staffId, note: string | null = null) => assignCleaning(v.rec.rc, { taskId: v.taskId, housekeeperStaffId: staffId, note })
async function toCleaned(v: V) {
  expect((await assign(v)).ok).toBe(true)
  const r = await completeCleaning(v.hk.rc, { taskId: v.taskId, checklist: FULL, notes: null })
  expect(r.ok, JSON.stringify(r)).toBe(true)
}

describe('assignment', () => {
  it('Reception assigns a housekeeper with an active grant; audited, and the housekeeper is told', async () => {
    const v = await vacated()
    const r = await assign(v)
    expect(r.ok && r.data).toMatchObject({ assignedTo: v.hk.staffId, reassigned: false })
    const t = await taskRow(v.taskId)
    expect(t.assigned_to_staff).toBe(v.hk.staffId)
    expect(t.assigned_by).toBe(v.rec.userId)
    expect((await auditActions(v.taskId)).at(-1)).toMatchObject({ action: 'readiness.cleaning.assigned', before: { assignedTo: null }, after: { assignedTo: v.hk.staffId } })
    const told = await notificationsByKey(`cleaning:${v.taskId}:assigned:`)
    expect(told).toHaveLength(1)
    expect(told[0]).toMatchObject({ to_staff_id: v.hk.staffId, kind: 'cleaning.assigned' })
    // Assigning the same person again changes nothing and tells nobody twice.
    expect((await assign(v)).ok).toBe(true)
    expect(await notificationsByKey(`cleaning:${v.taskId}:assigned:`)).toHaveLength(1)
  })

  it('a person without the Housekeeping capability cannot be assigned; neither can someone whose grant expired, was revoked, or who has left', async () => {
    const v = await vacated()
    const plain = await housekeeper({ grant: false })
    const noCap = await assign(v, plain.staffId)
    expect(noCap.ok).toBe(false)
    if (!noCap.ok) { expect(noCap.status).toBe(422); expect(noCap.reason).toMatch(/Housekeeping capability/); expect(noCap.fields).toHaveProperty('housekeeperStaffId') }

    const expired = await makeUser({ roles: [{ role: 'Res' }] })
    await grantCapability(expired.id, 'Housekeeping', { startsAt: new Date(Date.UTC(2025, 0, 1)), expiresAt: new Date(Date.UTC(2025, 1, 1)) })
    expect((await assign(v, expired.staffId)).ok).toBe(false)

    const revoked = await makeUser({ roles: [{ role: 'Res' }] })
    await grantCapability(revoked.id, 'Housekeeping')
    await admin().query(`UPDATE capability_grant SET status = 'revoked', revoked_at = now() WHERE user_id = $1`, [revoked.id])
    expect((await assign(v, revoked.staffId)).ok).toBe(false)

    const left = await housekeeper()
    await admin().query(`UPDATE staff_profile SET employment_status = 'left', left_at = now() WHERE id = $1`, [left.staffId])
    const l = await assign(v, left.staffId)
    expect(l.ok).toBe(false)

    expect((await taskRow(v.taskId)).assigned_to_staff).toBeNull()
  })

  it('never the person who lives in that room (D-26); a housekeeper in another room is fine', async () => {
    const v = await vacated()
    const neighbour = await housekeeper()
    await mkStay({ bedId: v.bedIds[1], staffId: neighbour.staffId, from: day(-5), to: null }) // same room, another bed
    const r = await assign(v, neighbour.staffId)
    expect(r.ok).toBe(false)
    if (!r.ok) { expect(r.code).toBe('separation_of_duties'); expect(r.status).toBe(403) }
    expect((await taskRow(v.taskId)).assigned_to_staff).toBeNull()
    const other = await housekeeper()
    const elsewhere = await scene({ beds: 1 })
    await mkStay({ bedId: elsewhere.bedIds[0], staffId: other.staffId, from: day(-5), to: null }) // lives in a different room
    expect((await assign(v, other.staffId)).ok).toBe(true)
  })

  it('reassigning while open needs a reason; with one it is allowed, and both housekeepers are told', async () => {
    const v = await vacated()
    const second = await housekeeper()
    expect((await assign(v)).ok).toBe(true)
    const no = await assign(v, second.staffId)
    expect(no.ok).toBe(false)
    if (!no.ok) { expect(no.code).toBe('conflict'); expect(no.detail).toMatchObject({ reason: 'already_assigned' }) }
    const yes = await assign(v, second.staffId, 'First housekeeper is off sick')
    expect(yes.ok && yes.data.reassigned).toBe(true)
    expect((await taskRow(v.taskId)).assigned_to_staff).toBe(second.staffId)
    const a = await auditActions(v.taskId)
    expect(a.at(-1)).toMatchObject({ action: 'readiness.cleaning.reassigned', reason: 'First housekeeper is off sick' })
    expect((await notificationsByKey(`cleaning:${v.taskId}:unassigned:`))[0]).toMatchObject({ to_staff_id: v.hk.staffId })
    expect((await notificationsByKey(`cleaning:${v.taskId}:assigned:`)).map(n => n.to_staff_id).sort()).toEqual([second.staffId, v.hk.staffId].sort())
    // A reassigned-away housekeeper no longer owns it.
    const stale = await completeCleaning(v.hk.rc, { taskId: v.taskId, checklist: FULL, notes: null })
    expect(stale.ok).toBe(false)
    if (!stale.ok) expect(stale.status).toBe(404)
  })

  it('who may assign: Reception and the Super Admin of the site; not a housekeeper, not another site (404), not once cleaned', async () => {
    const v = await vacated()
    const sa = await assignCleaning(v.sa.rc, { taskId: v.taskId, housekeeperStaffId: v.hk.staffId, note: null })
    expect(sa.ok).toBe(true)
    const other = await scene({ beds: 1 })
    const foreign = await assignCleaning(other.rec.rc, { taskId: v.taskId, housekeeperStaffId: v.hk.staffId, note: 'x y z' })
    expect(foreign.ok).toBe(false)
    if (!foreign.ok) expect(foreign.status).toBe(404)
    const byHk = await assignCleaning(v.hk.rc, { taskId: v.taskId, housekeeperStaffId: v.hk.staffId, note: null })
    expect(byHk.ok).toBe(false)
    if (!byHk.ok) expect(byHk.status).toBe(403)
    await completeCleaning(v.hk.rc, { taskId: v.taskId, checklist: FULL, notes: null })
    const late = await assign(v, (await housekeeper()).staffId, 'too late')
    expect(late.ok).toBe(false)
    if (!late.ok) expect(late.code).toBe('conflict')
  })

  it('two assignments at once: one wins, the other is told who has it', async () => {
    const v = await vacated()
    const [a, b] = [await housekeeper(), await housekeeper()]
    const rec2 = await person('Rec', { siteIds: [v.siteId] })
    const rs = await Promise.all([
      assignCleaning(v.rec.rc, { taskId: v.taskId, housekeeperStaffId: a.staffId, note: null }),
      assignCleaning(rec2.rc, { taskId: v.taskId, housekeeperStaffId: b.staffId, note: null }),
    ])
    expect(rs.filter(r => r.ok)).toHaveLength(1)
    const loser = rs.find(r => !r.ok)!
    expect(!loser.ok && loser.code).toBe('conflict')
    const winner = (await taskRow(v.taskId)).assigned_to_staff
    expect([a.staffId, b.staffId]).toContain(winner)
    expect((await auditActions(v.taskId)).filter(x => x.action.startsWith('readiness.cleaning.assign'))).toHaveLength(1)
  })
})

describe('cleaning', () => {
  it('only the assigned housekeeper can complete; another housekeeper, an unassigned task and Reception cannot', async () => {
    const v = await vacated()
    const other = await housekeeper()
    const unassigned = await completeCleaning(v.hk.rc, { taskId: v.taskId, checklist: FULL, notes: null })
    expect(!unassigned.ok && unassigned.status).toBe(404)
    await assign(v)
    const wrong = await completeCleaning(other.rc, { taskId: v.taskId, checklist: FULL, notes: null })
    expect(!wrong.ok && wrong.status).toBe(404)
    const rec = await completeCleaning(v.rec.rc, { taskId: v.taskId, checklist: FULL, notes: null })
    expect(!rec.ok && rec.status).toBe(403)
    expect((await taskRow(v.taskId)).status).toBe('open')
    expect((await bedRow(v.bedId)).state).toBe('needs_cleaning')
  })

  it('records the checklist as answered, moves the bed to Inspection required (not Available), audits and tells the inspectors', async () => {
    const v = await vacated()
    await assign(v)
    const r = await completeCleaning(v.hk.rc, { taskId: v.taskId, checklist: { ...FULL, damage: false }, notes: 'All good' })
    expect(r.ok && r.data).toMatchObject({ bedState: 'inspection_required', issueReported: false })
    const t = await taskRow(v.taskId)
    expect(t.status).toBe('cleaned')
    expect(t.cleaned_by_staff).toBe(v.hk.staffId)
    expect(t.checklist).toMatchObject({ version: 1, notes: 'All good', issue: false })
    expect(t.checklist.lines).toEqual(expect.arrayContaining([{ id: 'linen', label: 'Bed linen changed', required: true, done: true }, { id: 'damage', label: 'Damage or missing items noticed and noted', required: false, done: false }]))
    expect(await bedRow(v.bedId)).toMatchObject({ state: 'inspection_required' })
    expect((await auditActions(v.taskId)).at(-1)).toMatchObject({ action: 'readiness.cleaning.completed', before: { status: 'open', bed: 'needs_cleaning' }, after: { status: 'cleaned', bed: 'inspection_required' } })
    expect((await notificationsByKey(`cleaning:${v.taskId}:cleaned`))[0]).toMatchObject({ to_role: 'FinalInspection' })
    expect((await admin().query(`SELECT site_id FROM notification WHERE dedupe_key = $1`, [`cleaning:${v.taskId}:cleaned`])).rows[0].site_id).toBe(v.siteId)
    // A second submit is refused and changes nothing.
    const again = await completeCleaning(v.hk.rc, { taskId: v.taskId, checklist: FULL, notes: null })
    expect(!again.ok && again.code).toBe('conflict')
  })

  it('refuses while a required line is not ticked, naming the missing lines, and changes nothing', async () => {
    const v = await vacated()
    await assign(v)
    const r = await completeCleaning(v.hk.rc, { taskId: v.taskId, checklist: { linen: true, surfaces: true, bathroom: false }, notes: null })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.status).toBe(422)
      expect(r.reason).toContain('Bathroom cleaned')
      expect(r.reason).toContain('Bins emptied')
      expect(r.reason).not.toContain('Bed linen changed')
      expect(r.detail).toMatchObject({ reason: 'checklist_incomplete', missing: [{ id: 'bathroom' }, { id: 'bins' }] })
    }
    const t = await taskRow(v.taskId)
    expect(t.status).toBe('open')
    expect(t.checklist).toBeNull()
    expect((await bedRow(v.bedId)).state).toBe('needs_cleaning')
    const unknown = await completeCleaning(v.hk.rc, { taskId: v.taskId, checklist: { ...FULL, secret: true }, notes: null })
    expect(!unknown.ok && unknown.status).toBe(422)
  })

  it('damage or missing items need a note; with one it is a reportable issue: audited and the Maintenance Coordinator is told', async () => {
    const v = await vacated()
    await assign(v)
    const bare = await completeCleaning(v.hk.rc, { taskId: v.taskId, checklist: { ...FULL, damage: true }, notes: null })
    expect(!bare.ok && bare.fields).toHaveProperty('notes')
    expect((await taskRow(v.taskId)).status).toBe('open')
    const r = await completeCleaning(v.hk.rc, { taskId: v.taskId, checklist: { ...FULL, damage: true }, notes: 'Lamp broken, one pillow missing' })
    expect(r.ok && r.data.issueReported).toBe(true)
    const a = await auditActions(v.taskId)
    expect(a.map(x => x.action)).toContain('readiness.cleaning.issue_reported')
    expect(a.find(x => x.action === 'readiness.cleaning.issue_reported')?.reason).toBe('Lamp broken, one pillow missing')
    const mc = await notificationsByKey(`cleaning:${v.taskId}:issue`)
    expect(mc).toHaveLength(1)
    expect(mc[0]).toMatchObject({ to_role: 'MC', kind: 'cleaning.issue' })
    expect(mc[0].text).toContain('Lamp broken')
    expect((await taskRow(v.taskId)).checklist).toMatchObject({ issue: true, notes: 'Lamp broken, one pillow missing' })
  })

  it('nobody cleans their own room (D-26): refused with separation_of_duties even if the task was assigned to them behind the API', async () => {
    const v = await vacated()
    const neighbour = await housekeeper()
    await mkStay({ bedId: v.bedIds[1], staffId: neighbour.staffId, from: day(-5), to: null })
    await admin().query(`UPDATE cleaning_task SET assigned_to_staff = $2 WHERE id = $1`, [v.taskId, neighbour.staffId])
    const r = await completeCleaning(neighbour.rc, { taskId: v.taskId, checklist: FULL, notes: null })
    expect(r.ok).toBe(false)
    if (!r.ok) { expect(r.code).toBe('separation_of_duties'); expect(r.status).toBe(403) }
    expect((await taskRow(v.taskId)).status).toBe('open')
  })

  it('cannot be recorded for a bed that was blocked meanwhile, and says who unblocks it', async () => {
    const v = await vacated()
    await assign(v)
    await setBedState(v.bedId, 'blocked')
    const r = await completeCleaning(v.hk.rc, { taskId: v.taskId, checklist: FULL, notes: null })
    expect(r.ok).toBe(false)
    if (!r.ok) { expect(r.detail).toMatchObject({ reason: 'bed_state', state: 'blocked' }); expect(r.owner).toBe('Maintenance Coordinator'); expect(r.next).toBeTruthy() }
    expect((await taskRow(v.taskId)).status).toBe('open')
  })
})

describe('final inspection', () => {
  it('pass: task passed, bed Available with the reason cleared, audit with before and after, inspector recorded', async () => {
    const v = await vacated()
    await toCleaned(v)
    expect((await bedRow(v.bedId)).state_reason).toBe('Cleaned, awaiting final inspection')
    const r = await passInspection(v.insp.rc, { taskId: v.taskId, note: 'Spotless' })
    expect(r.ok && r.data).toMatchObject({ bedState: 'available' })
    expect(await bedRow(v.bedId)).toEqual({ state: 'available', state_reason: null })
    const t = await taskRow(v.taskId)
    expect(t).toMatchObject({ status: 'passed', inspected_by_staff: v.insp.staffId, inspected_by: v.insp.userId, inspection_note: 'Spotless', cleaned_by_staff: v.hk.staffId })
    expect((await auditActions(v.taskId)).at(-1)).toMatchObject({
      action: 'readiness.inspection.passed', reason: 'Spotless', before: { status: 'cleaned', bed: 'inspection_required' }, after: { status: 'passed', bed: 'available', stateReason: null },
    })
    // A second pass is refused.
    const again = await passInspection(v.insp.rc, { taskId: v.taskId, note: null })
    expect(!again.ok && again.code).toBe('conflict')
  })

  it('needs the Final Inspection capability at that site: a housekeeper and Reception get 403, another site gets 404; nothing changes', async () => {
    const v = await vacated()
    await toCleaned(v)
    for (const p of [v.hk, v.rec]) {
      const r = await passInspection(p.rc, { taskId: v.taskId, note: null })
      expect(!r.ok && r.status).toBe(403)
    }
    const other = await scene({ beds: 1 })
    const foreign = await passInspection(other.insp.rc, { taskId: v.taskId, note: null })
    expect(!foreign.ok && foreign.status).toBe(404)
    expect((await bedRow(v.bedId)).state).toBe('inspection_required')
  })

  it('cannot inspect before the room is cleaned', async () => {
    const v = await vacated()
    await assign(v)
    const r = await passInspection(v.insp.rc, { taskId: v.taskId, note: null })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.detail).toMatchObject({ reason: 'not_cleaned', status: 'open' })
    expect((await bedRow(v.bedId)).state).toBe('needs_cleaning')
  })

  it('the inspector is never the cleaner (D-26): refused with separation_of_duties, for pass and for fail', async () => {
    const v = await vacated()
    // One person holds both capabilities, cleans, and then tries to inspect their own work.
    const both = await inspector(v.siteId, 'Rec')
    await grantCapability(both.userId, 'Housekeeping')
    const asCleaner = rcFor(both.userId, { role: 'Rec', sites: [v.siteId], caps: ['FinalInspection', 'Housekeeping'], staffId: both.staffId }, both.rc.clock as never)
    expect((await assign(v, both.staffId)).ok).toBe(true)
    expect((await completeCleaning(asCleaner, { taskId: v.taskId, checklist: FULL, notes: null })).ok).toBe(true)
    const p = await passInspection(asCleaner, { taskId: v.taskId, note: null })
    expect(p.ok).toBe(false)
    if (!p.ok) { expect(p.code).toBe('separation_of_duties'); expect(p.status).toBe(403) }
    const f = await failInspection(asCleaner, { taskId: v.taskId, note: 'not good enough' })
    expect(!f.ok && f.code).toBe('separation_of_duties')
    expect((await taskRow(v.taskId)).status).toBe('cleaned')
    expect((await bedRow(v.bedId)).state).toBe('inspection_required')
    // The database refuses the same thing even if code is bypassed.
    await expect(admin().query(`UPDATE cleaning_task SET inspected_by_staff = cleaned_by_staff WHERE id = $1`, [v.taskId])).rejects.toThrow(/cleaning_cleaner_not_inspector/)
    // Another holder can.
    expect((await passInspection(v.insp.rc, { taskId: v.taskId, note: null })).ok).toBe(true)
  })

  it('nobody inspects their own room (D-26)', async () => {
    const v = await vacated()
    await toCleaned(v)
    await mkStay({ bedId: v.bedIds[2], staffId: v.insp.staffId, from: day(-3), to: null }) // the inspector lives in the same room
    const r = await passInspection(v.insp.rc, { taskId: v.taskId, note: null })
    expect(r.ok).toBe(false)
    if (!r.ok) { expect(r.code).toBe('separation_of_duties'); expect(r.reason).toMatch(/live in room/) }
    const f = await failInspection(v.insp.rc, { taskId: v.taskId, note: 'whatever it is' })
    expect(!f.ok && f.code).toBe('separation_of_duties')
    expect((await bedRow(v.bedId)).state).toBe('inspection_required')
  })

  it('fail needs a note and sets up the redo: old task failed, new open task "Failed inspection", bed Needs cleaning, Reception told to assign', async () => {
    const v = await vacated()
    await toCleaned(v)
    const r = await failInspection(v.insp.rc, { taskId: v.taskId, note: 'Floor still dirty under the bed' })
    expect(r.ok).toBe(true)
    const tasks = await cleaningTasks(v.bedId)
    expect(tasks.map(t => t.status)).toEqual(['failed', 'open'])
    const fresh = await taskRow(tasks[1].id)
    expect(fresh).toMatchObject({ assigned_to_staff: null, cleaned_by_staff: null, reason: 'Failed inspection' })
    expect((await bedRow(v.bedId)).state).toBe('needs_cleaning')
    expect((await bedRow(v.bedId)).state_reason).toContain('Floor still dirty')
    expect((await notificationsByKey(`cleaning:${tasks[1].id}:opened`))[0]).toMatchObject({ to_role: 'Rec' })
    const told = await notificationsByKey(`cleaning:${v.taskId}:failed`)
    expect(told[0].text).toContain('Floor still dirty under the bed')
    // The whole loop works a second time and ends Available.
    expect((await assignCleaning(v.rec.rc, { taskId: tasks[1].id, housekeeperStaffId: v.hk.staffId, note: null })).ok).toBe(true)
    expect((await completeCleaning(v.hk.rc, { taskId: tasks[1].id, checklist: FULL, notes: null })).ok).toBe(true)
    expect((await passInspection(v.insp.rc, { taskId: tasks[1].id, note: null })).ok).toBe(true)
    expect((await bedRow(v.bedId)).state).toBe('available')
  })

  it('two inspections of one task at once: one wins, the other is refused, the bed ends in exactly one state', async () => {
    for (const mix of ['pass+pass', 'pass+fail'] as const) {
      const v = await vacated()
      await toCleaned(v)
      const second = await inspector(v.siteId)
      const [a, b] = await Promise.all([
        passInspection(v.insp.rc, { taskId: v.taskId, note: null }),
        mix === 'pass+pass' ? passInspection(second.rc, { taskId: v.taskId, note: null }) : failInspection(second.rc, { taskId: v.taskId, note: 'not clean at all' }),
      ])
      expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1)
      const loser = a.ok ? b : a
      expect(!loser.ok && loser.code).toBe('conflict')
      const tasks = await cleaningTasks(v.bedId)
      const won = (await taskRow(v.taskId)).status
      if (won === 'passed') { expect(tasks).toHaveLength(1); expect((await bedRow(v.bedId)).state).toBe('available') }
      else { expect(won).toBe('failed'); expect(tasks).toHaveLength(2); expect((await bedRow(v.bedId)).state).toBe('needs_cleaning') }
    }
  })
})

describe('cancelling a task', () => {
  it('cannot cancel a task its bed still needs; can once the bed is blocked, and unblocking opens a fresh one', async () => {
    const v = await vacated()
    const still = await cancelTask(v.rec.rc, { taskId: v.taskId, reason: 'no longer needed' })
    expect(still.ok).toBe(false)
    if (!still.ok) expect(still.detail).toMatchObject({ reason: 'task_still_needed' })
    await setBedState(v.bedId, 'blocked')
    const r = await cancelTask(v.rec.rc, { taskId: v.taskId, reason: 'Bed blocked for repairs' })
    expect(r.ok && r.data.reopenedTaskId).toBeNull()
    expect((await taskRow(v.taskId)).status).toBe('cancelled')
    expect((await auditActions(v.taskId)).at(-1)).toMatchObject({ action: 'readiness.cleaning.cancelled', reason: 'Bed blocked for repairs' })
    expect((await cancelTask(v.rec.rc, { taskId: v.taskId, reason: 'again' })).ok).toBe(true) // idempotent
    // A cancelled task cannot be cleaned.
    const c = await completeCleaning(v.hk.rc, { taskId: v.taskId, checklist: FULL, notes: null })
    expect(c.ok).toBe(false)
  })

  it('a stale cleaned task (the bed went through a block) is cancelled and a fresh task opens, so the bed is never stuck', async () => {
    const v = await vacated()
    await toCleaned(v)
    await setBedState(v.bedId, 'blocked')
    await setBedState(v.bedId, 'needs_cleaning') // unblocked: the open/cleaned unique index kept the old task, so no new one was opened
    expect((await cleaningTasks(v.bedId)).map(t => t.status)).toEqual(['cleaned'])
    const pass = await passInspection(v.insp.rc, { taskId: v.taskId, note: null })
    expect(!pass.ok && pass.detail).toMatchObject({ reason: 'bed_state' }) // the bed is not in Inspection required, so nothing is released
    const r = await cancelTask(v.rec.rc, { taskId: v.taskId, reason: 'Bed was blocked after cleaning' })
    expect(r.ok && r.data.reopenedTaskId).toBeTruthy()
    expect((await cleaningTasks(v.bedId)).map(t => t.status)).toEqual(['cancelled', 'open'])
  })
})

describe('mkStaff helper unused guard', () => { it('keeps the import honest', () => { expect(typeof mkStaff).toBe('function') }) })
