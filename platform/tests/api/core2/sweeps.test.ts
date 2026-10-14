import { afterAll, describe, expect, it } from 'vitest'
import { admin, call, closeAll, uniq } from '../harness'
import { mkProperty, mkRequest, mkStaff, notificationsByKey, day } from '../fixtures2'
import { registerSweep, runSweep, runSweeps, listSweeps, systemTx, auditSystem } from '@/server/jobs/registry'
import '@/server/jobs/sweeps'
import { registerApprovalSource } from '@/server/approvals/registry'
import { FixedClock } from '@/server/clock'
import { POST as sweepRoute } from '../../../app/api/v1/internal/sweeps/route'
import { getPool } from '@/server/db/client'

afterAll(closeAll)

describe('sweep runner', () => {
  it('registers the approval reminder sweep', () => {
    expect(listSweeps().map(s => s.name)).toContain('approval_reminders')
  })

  it('records each run, and an unknown sweep fails cleanly', async () => {
    const name = uniq('sw')
    registerSweep({ name, description: 't', run: async () => ({ done: 2 }) })
    const out = await runSweep(name, new FixedClock())
    expect(out).toMatchObject({ ok: true, summary: { done: 2 } })
    const rows = (await admin().query(`SELECT ok, summary FROM sweep_run WHERE name = $1`, [name])).rows
    expect(rows).toEqual([{ ok: true, summary: { done: 2 } }])
    expect((await runSweep('nope', new FixedClock())).ok).toBe(false)
  })

  it('one failing sweep is recorded and does not stop the others', async () => {
    const bad = uniq('bad'), good = uniq('good')
    registerSweep({ name: bad, description: 't', run: async () => { throw new Error('boom') } })
    registerSweep({ name: good, description: 't', run: async () => ({ ok: 1 }) })
    const out = await runSweeps(new FixedClock(), [bad, good])
    expect(out.find(o => o.name === bad)).toMatchObject({ ok: false, error: 'boom' })
    expect(out.find(o => o.name === good)).toMatchObject({ ok: true })
  })

  it('two runners at once: the second skips instead of doubling up', async () => {
    const name = uniq('lock')
    let running = 0, maxRunning = 0
    registerSweep({ name, description: 't', run: async () => { running++; maxRunning = Math.max(maxRunning, running); await new Promise(r => setTimeout(r, 300)); running--; return { n: 1 } } })
    const [a, b] = await Promise.all([runSweep(name, new FixedClock()), runSweep(name, new FixedClock())])
    expect(maxRunning).toBe(1)
    expect([a.skipped, b.skipped].filter(Boolean)).toHaveLength(1)
    expect(getPool().totalCount).toBeGreaterThan(0)
  })

  it('system transactions audit with no user and the role "system"', async () => {
    const siteId = (await mkProperty({ beds: 0 })).siteId
    const name = uniq('aud')
    registerSweep({ name, description: 't', run: async ctx => { await systemTx(ctx, tx => auditSystem(tx, ctx, { action: 'sweep.test', siteId })); return {} } })
    await runSweep(name, new FixedClock())
    const row = (await admin().query(`SELECT actor_user_id, actor_role FROM audit_event WHERE action = 'sweep.test' AND site_id = $1`, [siteId])).rows[0]
    expect(row).toEqual({ actor_user_id: null, actor_role: 'system' })
  })
})

describe('approval reminders (reminds and escalates, never decides)', () => {
  it('reminder at 1 business day, backup at 2, escalation at 3; each once; the item itself never changes', async () => {
    const { siteId } = await mkProperty({ beds: 1 })
    const staff = await mkStaff()
    // Monday 12 Oct 2026 09:00 UTC (a business day; weekends are Sat/Sun by default)
    const created = new Date(Date.UTC(2026, 9, 12, 9, 0, 0))
    const reqId = await mkRequest({ staffId: staff.id, siteId, createdAt: created })
    const kind = uniq('t_request')
    registerApprovalSource({
      kind,
      listPending: async db => {
        // the test source only reports its own request
        const rows = await db.select().from((await import('@/server/db/schema')).accommodationRequest)
        return rows.filter(r => r.id === reqId && r.status === 'submitted').map(r => ({
          kind, ref: r.id, siteId: r.siteId, subjectStaffIds: [r.staffId], title: 'Accommodation request', sub: '', createdAt: r.createdAt.getTime(), href: '/x',
          deciders: [
            { level: 0 as const, label: 'Accommodation Admin', action: 'requests_waitlist.approve' as const, notify: 'AA' as const },
            { level: 1 as const, label: 'Policy Approver', action: 'requests_waitlist.approve_exception' as const, notify: 'PolicyApprover' as const },
            { level: 2 as const, label: 'Policy Approver / Super Admin', action: 'requests_waitlist.approve_exception' as const, notify: 'SA' as const },
          ],
        }))
      },
    })
    const clock = new FixedClock(created)
    const counts = async () => (await notificationsByKey(`approval:${kind}:${reqId}`)).map(n => n.dedupe_key.split(':').pop()).sort()

    clock.set(new Date(created.getTime() + 23 * 3600_000)); await runSweep('approval_reminders', clock)
    expect(await counts()).toEqual([])                                         // inside the first day
    clock.set(new Date(created.getTime() + 25 * 3600_000)); await runSweep('approval_reminders', clock)
    expect(await counts()).toEqual(['reminder1'])                              // 1 business day: reminder to AA
    clock.set(new Date(created.getTime() + 49 * 3600_000)); await runSweep('approval_reminders', clock)
    expect(await counts()).toEqual(['backup', 'reminder1'])                    // 2: routed to the backup
    clock.set(new Date(created.getTime() + 73 * 3600_000)); await runSweep('approval_reminders', clock)
    await runSweep('approval_reminders', clock)                                 // run again: nothing doubles
    expect(await counts()).toEqual(['backup', 'escalated', 'reminder1'])

    const after = (await admin().query(`SELECT status, decided_by FROM accommodation_request WHERE id = $1`, [reqId])).rows[0]
    expect(after).toEqual({ status: 'submitted', decided_by: null })           // reminded, never decided
    const recipients = (await notificationsByKey(`approval:${kind}:${reqId}`)).map(n => `${n.dedupe_key.split(':').pop()}=${n.to_role}`).sort()
    expect(recipients).toEqual(['backup=PolicyApprover', 'escalated=SA', 'reminder1=AA'])
  })

  it('weekends do not count towards the SLA', async () => {
    const { siteId } = await mkProperty({ beds: 1 })
    const staff = await mkStaff()
    const friday = new Date(Date.UTC(2026, 9, 16, 17, 0, 0)) // Friday 17:00
    const reqId = await mkRequest({ staffId: staff.id, siteId, createdAt: friday })
    const kind = uniq('t_wk')
    registerApprovalSource({ kind, listPending: async db => {
      const rows = await db.select().from((await import('@/server/db/schema')).accommodationRequest)
      return rows.filter(r => r.id === reqId).map(r => ({ kind, ref: r.id, siteId: r.siteId, subjectStaffIds: [r.staffId], title: 't', sub: '', createdAt: r.createdAt.getTime(), href: '/x',
        deciders: [{ level: 0 as const, label: 'AA', action: 'requests_waitlist.approve' as const, notify: 'AA' as const }] }))
    } })
    // Sunday 17:00 = two calendar days later, zero business days
    await runSweep('approval_reminders', new FixedClock(new Date(friday.getTime() + 48 * 3600_000)))
    expect(await notificationsByKey(`approval:${kind}:${reqId}`)).toHaveLength(0)
    // Monday 17:00: one business day
    await runSweep('approval_reminders', new FixedClock(new Date(friday.getTime() + 72 * 3600_000 + 1000)))
    expect(await notificationsByKey(`approval:${kind}:${reqId}`)).toHaveLength(1)
    expect(day(0)).toBeTruthy()
  })
})

describe('POST /api/v1/internal/sweeps', () => {
  it('is disabled without a token, refuses a wrong one and runs with the right one', async () => {
    delete process.env.INTERNAL_JOB_TOKEN
    expect((await call(sweepRoute, { body: {} })).status).toBe(404)
    process.env.INTERNAL_JOB_TOKEN = 'secret-token-for-tests'
    try {
      expect((await call(sweepRoute, { body: {} })).status).toBe(401)
      expect((await call(sweepRoute, { body: {}, headers: { authorization: 'Bearer wrong' } })).status).toBe(401)
      const r = await call(sweepRoute, { body: { only: ['approval_reminders'] }, headers: { authorization: 'Bearer secret-token-for-tests' } })
      expect(r.status).toBe(200)
      expect(r.body.data.outcomes.map((o: any) => o.name)).toEqual(['approval_reminders'])
    } finally { delete process.env.INTERNAL_JOB_TOKEN }
  })
})
