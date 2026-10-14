import { afterAll, describe, expect, it } from 'vitest'
import { admin, closeAll } from '../harness'
import { auditActions, bedRow, cleaningTasks, day, FULL, housekeeper, mkStaff, notificationsByKey, scene, staffAt, taskRow, vacate } from './helpers'
import { runCommand } from '@/server/command/run'
import { allocateBed } from '@/server/allocation'
import { assignCleaning } from '@/server/commands/readiness/assign'
import { completeCleaning } from '@/server/commands/readiness/clean'
import { failInspection, passInspection } from '@/server/commands/readiness/inspect'
import { addToWaitlist } from '@/server/commands/waitlist/add'
import { offerToNext } from '@/server/commands/waitlist/offer'

afterAll(closeAll)

const checkInAttempt = (s: Awaited<ReturnType<typeof scene>>, bedId: string, staffId: string) =>
  runCommand(s.rec.rc, async c => allocateBed(c, { bedId, staffId, from: day(0), kind: 'stay', requireReady: true }))

describe('AT-021 checkout is complete but the bed is not ready', () => {
  it('the bed stays Needs cleaning, then Inspection required; it cannot be checked into until a passed final inspection', async () => {
    const s = await scene({ beds: 2 })
    const bedId = s.bedIds[0]
    const next = await mkStaff()

    // The REAL checkout (WP-F) opens the task and moves the bed to Needs cleaning. Nothing else.
    const { taskId } = await vacate(s, bedId)
    expect((await bedRow(bedId)).state).toBe('needs_cleaning')
    expect((await cleaningTasks(bedId)).map(t => t.status)).toEqual(['open'])
    const blocked = await checkInAttempt(s, bedId, next.id)
    expect(blocked.ok).toBe(false)
    if (!blocked.ok) expect(blocked.detail).toMatchObject({ reason: 'bed_not_ready', state: 'needs_cleaning' })

    // Assigned and cleaned: still not Available (D-64, SRS 12.53).
    expect((await assignCleaning(s.rec.rc, { taskId, housekeeperStaffId: s.hk.staffId, note: null })).ok).toBe(true)
    expect((await bedRow(bedId)).state).toBe('needs_cleaning')
    const cleaned = await completeCleaning(s.hk.rc, { taskId, checklist: FULL, notes: null })
    expect(cleaned.ok, JSON.stringify(cleaned)).toBe(true)
    expect((await bedRow(bedId)).state).toBe('inspection_required')
    const blocked2 = await checkInAttempt(s, bedId, next.id)
    expect(blocked2.ok).toBe(false)
    if (!blocked2.ok) expect(blocked2.detail).toMatchObject({ reason: 'bed_not_ready', state: 'inspection_required' })

    // Only a passed final inspection makes it Available, and then it can be checked into.
    const passed = await passInspection(s.insp.rc, { taskId, note: null })
    expect(passed.ok, JSON.stringify(passed)).toBe(true)
    expect((await bedRow(bedId)).state).toBe('available')
    expect((await checkInAttempt(s, bedId, next.id)).ok).toBe(true)
  })

  it('a reservation for a later date can still be made on a bed that is not ready (D-18), and does not make it ready', async () => {
    const s = await scene({ beds: 1 })
    await vacate(s, s.bedIds[0])
    const later = await runCommand(s.rec.rc, async c => allocateBed(c, { bedId: s.bedIds[0], staffId: (await mkStaff()).id, from: day(10), to: day(40), kind: 'reservation' }))
    expect(later.ok, JSON.stringify(later)).toBe(true)
    expect((await bedRow(s.bedIds[0])).state).toBe('needs_cleaning')
  })

  it('the waitlist hears about the bed only when it becomes Available, tells the Admin who is next, and creates no offer (D-108)', async () => {
    const s = await scene({ beds: 1 })
    const bedId = s.bedIds[0]
    const waiting = await mkStaff()
    const wl = await addToWaitlist(s.rec.rc, { staffId: waiting.id, siteId: s.siteId, arrival: day(1), end: day(60) })
    expect(wl.ok, JSON.stringify(wl)).toBe(true)
    const { taskId } = await vacate(s, bedId)
    await assignCleaning(s.rec.rc, { taskId, housekeeperStaffId: s.hk.staffId, note: null })
    await completeCleaning(s.hk.rc, { taskId, checklist: FULL, notes: null })

    // Checkout, assignment and cleaning told nobody about a free bed.
    expect(await notificationsByKey(`waitlist:bed:${bedId}:`)).toHaveLength(0)

    expect((await passInspection(s.insp.rc, { taskId, note: null })).ok).toBe(true)
    const told = await notificationsByKey(`waitlist:bed:${bedId}:cleaning:${taskId}:passed`)
    expect(told).toHaveLength(1)
    expect(told[0]).toMatchObject({ kind: 'waitlist.bed_free', to_role: 'AA' })
    expect(told[0].text).toContain('Next in the waitlist queue')
    // No offer, no hold: a person decides.
    expect((await admin().query(`SELECT 1 FROM bed_offer WHERE bed_id = $1`, [bedId])).rowCount).toBe(0)
    expect((await admin().query(`SELECT 1 FROM bed_claim WHERE bed_id = $1 AND released_at IS NULL`, [bedId])).rowCount).toBe(0)
  })

  it('readiness half of the exit journey: after the pass a person (the Admin) offers the freed bed to the next waiting resident, and not before', async () => {
    const s = await scene({ beds: 1 })
    const bedId = s.bedIds[0]
    const aa = await staffAt('AA', s.siteId)
    const waiting = await mkStaff()
    expect((await addToWaitlist(s.rec.rc, { staffId: waiting.id, siteId: s.siteId, arrival: day(1), end: day(60) })).ok).toBe(true)
    const { taskId } = await vacate(s, bedId)
    await assignCleaning(s.rec.rc, { taskId, housekeeperStaffId: s.hk.staffId, note: null })
    await completeCleaning(s.hk.rc, { taskId, checklist: FULL, notes: null })
    await passInspection(s.insp.rc, { taskId, note: null })
    const offer = await offerToNext(aa.rc, { bedId })
    expect(offer.ok, JSON.stringify(offer)).toBe(true)
    expect(offer.ok && offer.data).toMatchObject({ bedId, created: true })
    expect((await admin().query(`SELECT staff_id FROM bed_offer WHERE bed_id = $1`, [bedId])).rows.map(r => r.staff_id)).toEqual([waiting.id])
  })

  it('a failed inspection returns the bed to Needs cleaning with a NEW task, and the bed is still not available', async () => {
    const s = await scene({ beds: 1 })
    const bedId = s.bedIds[0]
    const { taskId } = await vacate(s, bedId)
    await assignCleaning(s.rec.rc, { taskId, housekeeperStaffId: s.hk.staffId, note: null })
    await completeCleaning(s.hk.rc, { taskId, checklist: FULL, notes: null })
    const failed = await failInspection(s.insp.rc, { taskId, note: 'Mould in the bathroom corner' })
    expect(failed.ok, JSON.stringify(failed)).toBe(true)
    if (!failed.ok) return
    expect((await bedRow(bedId)).state).toBe('needs_cleaning')
    const tasks = await cleaningTasks(bedId)
    expect(tasks.map(t => t.status)).toEqual(['failed', 'open'])
    expect(tasks[1].reason).toBe('Failed inspection')
    expect(failed.data.newTaskId).toBe(tasks[1].id)
    expect((await taskRow(taskId)).inspection_note).toBe('Mould in the bathroom corner')
    // The housekeeper is told what to redo.
    expect((await notificationsByKey(`cleaning:${taskId}:failed`))[0]).toMatchObject({ to_staff_id: s.hk.staffId })
    expect((await auditActions(taskId)).map(a => a.action)).toEqual(expect.arrayContaining(['readiness.cleaning.assigned', 'readiness.cleaning.completed', 'readiness.inspection.failed']))
    const blocked = await checkInAttempt(s, bedId, (await mkStaff()).id)
    expect(blocked.ok).toBe(false)
    void housekeeper
  })
})
