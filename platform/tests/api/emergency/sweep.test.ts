import { afterAll, describe, expect, it } from 'vitest'
import { admin, closeAll } from '../harness'
import { mkProperty } from '../fixtures2'
import { FixedClock } from '@/server/clock'
import { getDb } from '@/server/db/client'
import { listSweeps, runSweep } from '@/server/jobs/registry'
import '@/server/jobs/sweeps'
import { emergencyReminders } from '@/server/jobs/sweeps/emergency'
import { pendingDrafts, listInbox } from '@/server/approvals/inbox'
import { approveEmergency } from '@/server/commands/emergency/decide'
import { dueReminders, escalationFor, reminderDueAt } from '@/server/commands/emergency/rules'
import { HOUR, T0, auditFor, bedState, caseRow, claimOf, checkOutByHand, notifs, stayRow, start, sweepCtx, taskFor, who, world, type World } from './helpers'

afterAll(closeAll)

const at = (ms: number) => new FixedClock(T0.getTime() + ms)
const sweep = (caseId: string, ms: number) => emergencyReminders(sweepCtx(at(ms)), [caseId])
const keys = async (caseId: string) => (await notifs(caseId)).map(n => n.dedupe_key.replace(`emergency:${caseId}:`, ''))
const audits = async (caseId: string, action: string) => (await auditFor(caseId)).filter(a => a.action === action)

/** Nothing was decided, moved or checked out for a person. */
async function expectUndecided(w: World, e: { caseId: string; stayId: string; bedId: string }) {
  expect(await caseRow(e.caseId)).toMatchObject({ status: 'pending', decided_by: null, decided_at: null })
  expect(await stayRow(e.stayId)).toMatchObject({ status: 'provisional', checked_out_at: null, bed_id: e.bedId })
  expect(await bedState(e.bedId)).toBe('occupied')
  expect(await claimOf(e.stayId)).toMatchObject({ kind: 'stay', released_at: null })
  expect(await taskFor(e.caseId)).toHaveLength(0)
  const actions = (await auditFor(e.caseId)).map(a => a.action)
  for (const forbidden of ['emergency.approved', 'emergency.rejected', 'stay.checked_out']) expect(actions).not.toContain(forbidden)
  void w
}

describe('the clock (pure)', () => {
  const t = { deadlineHours: 24, realertHours: 24, escalateAfter: 2 }
  const d = T0.getTime() + 24 * HOUR
  it('reminder n is due at the deadline plus (n - 1) re-alerts; escalation follows the count', () => {
    expect(dueReminders(d, d - 1, t)).toBe(0)
    expect(dueReminders(d, d, t)).toBe(1)
    expect(dueReminders(d, d + 24 * HOUR - 1, t)).toBe(1)
    expect(dueReminders(d, d + 24 * HOUR, t)).toBe(2)
    expect(dueReminders(d, d + 48 * HOUR, t)).toBe(3)
    expect([0, 1, 2, 3, 4].map(n => escalationFor(n, t))).toEqual([0, 0, 1, 2, 2])
    expect(reminderDueAt(d, 2, t) - d).toBe(24 * HOUR)
  })
  it('follows the configured numbers', () => {
    const c = { deadlineHours: 4, realertHours: 2, escalateAfter: 3 }
    const dd = 4 * HOUR
    expect(dueReminders(dd, dd + 2 * HOUR, c)).toBe(2)
    expect([1, 2, 3, 4].map(n => escalationFor(n, c))).toEqual([0, 0, 1, 2])
  })
})

describe('AT-015: a pending emergency check-in beyond 24 hours', () => {
  it('is reminded exactly at the deadline, not a millisecond before, and the stay is still Provisional', async () => {
    const w = await world()
    const e = await start(w)
    const before = await sweep(e.caseId, 24 * HOUR - 1)
    expect(before).toMatchObject({ checked: 0, reminded: 0 })
    expect(await keys(e.caseId)).toEqual(['initiated'])
    expect(await caseRow(e.caseId)).toMatchObject({ reminders: 0, escalation: 0 })

    const after = await sweep(e.caseId, 24 * HOUR)
    expect(after).toMatchObject({ reminded: 1, escalated: 0 })
    expect(await keys(e.caseId)).toEqual(['initiated', 'reminder1'])
    const [reminder] = (await notifs(e.caseId)).filter(n => n.dedupe_key.endsWith('reminder1'))
    expect(reminder).toMatchObject({ to_role: 'AA', kind: 'emergency.reminder', critical: true })
    expect(reminder.text).toContain('stays provisional until a person decides')
    expect(await caseRow(e.caseId)).toMatchObject({ reminders: 1, escalation: 0, status: 'pending' })
    await expectUndecided(w, e)
  })

  it('repeated sweeps do not duplicate the reminder or its audit row', async () => {
    const w = await world()
    const e = await start(w)
    for (const ms of [24 * HOUR, 24 * HOUR + 1, 30 * HOUR, 47 * HOUR]) await sweep(e.caseId, ms)
    expect(await keys(e.caseId)).toEqual(['initiated', 'reminder1'])
    expect(await audits(e.caseId, 'emergency.reminder')).toHaveLength(1)
    expect((await caseRow(e.caseId)).reminders).toBe(1)
  })

  it('an AA-initiated case reminds the Policy Approver', async () => {
    const w = await world()
    const e = await start(w, { by: w.aaInit })
    await sweep(e.caseId, 24 * HOUR)
    expect((await notifs(e.caseId)).find(n => n.dedupe_key.endsWith('reminder1'))).toMatchObject({ to_role: 'PolicyApprover' })
  })

  it('shows in the approvals inbox with its own hour clock, so the business-day sweep leaves it alone', async () => {
    const w = await world()
    const e = await start(w)
    await sweep(e.caseId, 24 * HOUR)
    const now = at(25 * HOUR).now()
    const draft = (await pendingDrafts(getDb(), now)).find(d => d.ref === e.caseId)
    expect(draft).toMatchObject({ kind: 'emergency', siteId: w.siteId, urgent: true, href: `/emergency/${e.caseId}`, subjectStaffIds: [e.staffId] })
    expect(draft?.ownClock).toMatchObject({ reminders: 1, level: 0, label: 'Reminded' })

    const aaItem = (await listInbox(getDb(), w.aa.rc(at(25 * HOUR)).actor, now)).find(i => i.ref === e.caseId)
    expect(aaItem).toMatchObject({ kind: 'emergency', mine: true })
    // Reception has no approval action at all, so it is not in their inbox
    expect((await listInbox(getDb(), w.rec.rc(at(25 * HOUR)).actor, now)).find(i => i.ref === e.caseId)).toBeUndefined()

    // an AA-initiated case goes to a Policy Approver's inbox, never to the AA who started it
    const e2 = await start(w, { by: w.aaInit, bedIndex: 1 })
    expect((await listInbox(getDb(), w.aaInit.rc(at(25 * HOUR)).actor, now)).find(i => i.ref === e2.caseId)).toBeUndefined()
    expect((await listInbox(getDb(), w.pa.rc(at(25 * HOUR)).actor, now)).find(i => i.ref === e2.caseId)).toMatchObject({ kind: 'emergency', mine: true })
  })
})

describe('AT-016: two reminders unanswered', () => {
  it('escalates to the authorised backup at the second reminder and to the Policy Approver and Super Admin after it; never decides', async () => {
    const w = await world()
    const e = await start(w)
    await sweep(e.caseId, 24 * HOUR)
    await sweep(e.caseId, 48 * HOUR - 1)
    expect(await caseRow(e.caseId)).toMatchObject({ reminders: 1, escalation: 0 })

    await sweep(e.caseId, 48 * HOUR)
    expect(await caseRow(e.caseId)).toMatchObject({ reminders: 2, escalation: 1, status: 'pending' })
    const level1 = (await notifs(e.caseId)).find(n => n.dedupe_key.endsWith('escalated1:backup'))
    expect(level1).toMatchObject({ to_role: 'BackupApprover', kind: 'emergency.escalated', critical: true })
    expect(level1?.text).toContain('Nobody has been moved or checked out')
    await expectUndecided(w, e)

    await sweep(e.caseId, 72 * HOUR - 1)
    expect(await caseRow(e.caseId)).toMatchObject({ reminders: 2, escalation: 1 })
    await sweep(e.caseId, 72 * HOUR)
    expect(await caseRow(e.caseId)).toMatchObject({ reminders: 3, escalation: 2, status: 'pending' })
    const level2 = (await notifs(e.caseId)).filter(n => n.dedupe_key.includes('escalated2'))
    expect(level2.map(n => n.to_role).sort()).toEqual(['PolicyApprover', 'SA'])
    expect(level2.every(n => n.critical)).toBe(true)
    expect((await audits(e.caseId, 'emergency.escalated')).map(a => a.after.escalation)).toEqual([1, 2])

    // days later still nothing is decided for anyone
    await sweep(e.caseId, 200 * HOUR)
    await expectUndecided(w, e)
    expect(await caseRow(e.caseId)).toMatchObject({ escalation: 2 })
  })

  it('a sweep that was down catches up in one run and once only', async () => {
    const w = await world()
    const e = await start(w)
    const first = await sweep(e.caseId, 96 * HOUR)
    expect(first).toMatchObject({ reminded: 4, escalated: 2 })
    expect(await caseRow(e.caseId)).toMatchObject({ reminders: 4, escalation: 2 })
    expect(await keys(e.caseId)).toEqual(expect.arrayContaining(['reminder1', 'reminder2', 'reminder3', 'reminder4', 'escalated1:backup', 'escalated2:policy', 'escalated2:sa']))
    const again = await sweep(e.caseId, 96 * HOUR)
    expect(again).toMatchObject({ reminded: 0, escalated: 0 })
    expect((await notifs(e.caseId)).length).toBe(8)
  })

  it('with nobody holding the Backup Approver capability for the site, level 1 goes to the Policy Approvers instead of being lost (GH-07)', async () => {
    const p = await mkProperty({ beds: 1 })
    const rec = await who('Rec', { siteIds: [p.siteId], caps: ['EmergencyCheckin'] })
    const w = { ...p, rec } as unknown as World
    const e = await start(w)
    await sweep(e.caseId, 48 * HOUR)
    const level1 = (await notifs(e.caseId)).filter(n => n.dedupe_key.includes('escalated1'))
    expect(level1.map(n => n.to_role)).toEqual(['PolicyApprover'])
    expect(level1[0].text).toContain('no backup approver is assigned')
  })

  it('two or three sweeps at the same moment do the thing once', async () => {
    const w = await world()
    const e = await start(w)
    await Promise.all([sweep(e.caseId, 48 * HOUR), sweep(e.caseId, 48 * HOUR), sweep(e.caseId, 48 * HOUR)])
    expect(await caseRow(e.caseId)).toMatchObject({ reminders: 2, escalation: 1 })
    expect(await keys(e.caseId)).toEqual(expect.arrayContaining(['initiated', 'reminder1', 'reminder2', 'escalated1:backup']))
    expect((await notifs(e.caseId)).length).toBe(4)
    expect(await audits(e.caseId, 'emergency.reminder')).toHaveLength(2)
    expect(await audits(e.caseId, 'emergency.escalated')).toHaveLength(1)
  })

  it('a decision racing a sweep: whichever wins, there is no reminder for a decided case and no second decision', async () => {
    const w = await world()
    const e = await start(w)
    const [, decided] = await Promise.all([sweep(e.caseId, 30 * HOUR), approveEmergency(w.aa.rc(at(30 * HOUR)), { caseId: e.caseId })])
    expect(decided.ok).toBe(true)
    await sweep(e.caseId, 100 * HOUR)
    const c = await caseRow(e.caseId)
    expect(c.status).toBe('approved')
    expect(c.reminders).toBeLessThanOrEqual(1)
    expect(c.escalation).toBe(0)
  })
})

describe('what a sweep never touches', () => {
  it('a decided case and a case whose stay was checked out by a person get no reminders', async () => {
    const w = await world()
    const decided = await start(w, { bedIndex: 0 })
    await approveEmergency(w.aa.rc(at(2 * HOUR)), { caseId: decided.caseId })
    const out = await start(w, { bedIndex: 1 })
    await checkOutByHand(out.stayId)
    for (const e of [decided, out]) await sweep(e.caseId, 100 * HOUR)
    for (const e of [decided, out]) {
      expect(await caseRow(e.caseId)).toMatchObject({ reminders: 0, escalation: 0 })
      expect(await keys(e.caseId)).not.toContain('reminder1')
    }
  })

  it('the registered sweeps exist and run as sweeps (a clock before any deadline does nothing)', async () => {
    const names = listSweeps().map(s => s.name)
    expect(names).toEqual(expect.arrayContaining(['emergency_reminders', 'emergency_relocation_overdue']))
    const early = new FixedClock(T0.getTime() - 365 * 24 * HOUR)
    for (const name of ['emergency_reminders', 'emergency_relocation_overdue']) {
      let out = await runSweep(name, early)
      for (let i = 0; out.skipped && i < 50; i++) { await new Promise(r => setTimeout(r, 100)); out = await runSweep(name, early) }
      expect(out).toMatchObject({ ok: true })
      expect(out.summary).toMatchObject({ checked: 0 })
    }
    const r = (await admin().query(`SELECT count(*)::int AS n FROM sweep_run WHERE name = 'emergency_reminders' AND ok`)).rows[0]
    expect(r.n).toBeGreaterThan(0)
  })
})
