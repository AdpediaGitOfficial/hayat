/// <reference types="vite/client" />
/**
 * AT-039 (sweeps). A sweep acts on its own, so its audit rows carry no user and the role "system", the entity and its site, and are written in
 * the same transaction as the reminder or flag they record. Running the same sweep again writes nothing new, and nobody is moved or decided
 * for (the sweeps only remind and escalate). Runs in a private database because a sweep looks at every row it can see.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { createIsolated } from '../access/isolated'
import { FixedClock } from '@/server/clock'
import { runSweep } from '@/server/jobs/registry'
import '@/server/jobs/sweeps'
import { initiateEmergency } from '@/server/commands/emergency/initiate'
import { invKit, T0, day } from './kit'

const iso = await createIsolated()
afterAll(() => iso.close())
const k = invKit(iso)
const q = k.q
const HOUR = 3_600_000
const at = (ms: number) => new FixedClock(T0.getTime() + ms)

const systemRows = (action: string, entityId: string) => q<{ actor_user_id: string | null; actor_role: string | null; entity_type: string; site_id: string | null; request_id: string | null; reason: string | null; after: any }>(
  `SELECT actor_user_id, actor_role, entity_type, site_id, request_id, reason, after FROM audit_event WHERE action = $1 AND entity_id = $2 ORDER BY seq`, [action, entityId])

function expectSystemRow(rows: Awaited<ReturnType<typeof systemRows>>, o: { type: string; site: string }) {
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ actor_user_id: null, actor_role: 'system', entity_type: o.type, site_id: o.site })
  expect(rows[0].request_id, 'the sweep run is recorded as the request').toMatch(/^sweep-/)
}

describe('AT-039 sweeps write system audit events', () => {
  it('waitlist: the reminder before an entry ends and the expiry, once each, even when the sweep runs twice', async () => {
    const p = await k.property({ beds: 1 })
    const a = await k.staff(), b = await k.staff()
    const soon = (await q<{ id: string }>(`INSERT INTO waitlist_entry (staff_id, site_id, expires_at, arrival_date, stay_type, status) VALUES ($1, $2, $3, $4, 'contract', 'waiting') RETURNING id`, [a.id, p.siteId, new Date(T0.getTime() + 2 * 24 * HOUR), day(10)]))[0].id
    const lapsed = (await q<{ id: string }>(`INSERT INTO waitlist_entry (staff_id, site_id, expires_at, arrival_date, stay_type, status) VALUES ($1, $2, $3, $4, 'contract', 'waiting') RETURNING id`, [b.id, p.siteId, new Date(T0.getTime() - HOUR), day(10)]))[0].id
    expect((await runSweep('waitlist_expiry', at(0))).ok).toBe(true)
    expect((await runSweep('waitlist_expiry', at(0))).ok).toBe(true)
    expectSystemRow(await systemRows('waitlist.entry.reminded', soon), { type: 'waitlist_entry', site: p.siteId })
    expectSystemRow(await systemRows('waitlist.entry.expired', lapsed), { type: 'waitlist_entry', site: p.siteId })
    expect((await q<{ status: string }>(`SELECT status FROM waitlist_entry WHERE id = $1`, [soon]))[0].status, 'a reminder decides nothing').toBe('waiting')
  })

  it('readiness: the reminder and the escalation of an overdue cleaning task; the bed stays as it is', async () => {
    const p = await k.property({ beds: 1 })
    await q(`UPDATE bed SET state = 'occupied' WHERE id = $1`, [p.bedIds[0]])
    await q(`UPDATE bed SET state = 'needs_cleaning' WHERE id = $1`, [p.bedIds[0]])
    const taskId = (await q<{ id: string }>(`INSERT INTO cleaning_task (bed_id, site_id, reason, status, created_at) VALUES ($1, $2, 'Checked out', 'open', $3) RETURNING id`, [p.bedIds[0], p.siteId, new Date(T0.getTime() - 100 * HOUR)]))[0].id
    expect((await runSweep('readiness_cleaning_reminders', at(0))).ok).toBe(true)
    expect((await runSweep('readiness_cleaning_reminders', at(0))).ok).toBe(true)
    expectSystemRow(await systemRows('readiness.cleaning.sla_reminder', taskId), { type: 'cleaning_task', site: p.siteId })
    expectSystemRow(await systemRows('readiness.cleaning.sla_escalated', taskId), { type: 'cleaning_task', site: p.siteId })
    expect((await q<{ state: string }>(`SELECT state FROM bed WHERE id = $1`, [p.bedIds[0]]))[0].state, 'a reminder never makes a bed ready').toBe('needs_cleaning')
  })

  it('emergency: the reminder of a pending check-in and the alert of an overdue relocation task; nobody is approved, rejected or moved', async () => {
    const p = await k.property({ beds: 1 })
    const rec = await k.cast('Rec', { siteId: p.siteId, caps: ['EmergencyCheckin'] })
    const person = await k.staff()
    const started = await initiateEmergency(rec.rc(), { staffId: person.id, bedId: p.bedIds[0], reason: 'Flood in block B, relocated overnight' })
    if (!started.ok) throw new Error(started.reason)
    const taskId = (await q<{ id: string }>(`INSERT INTO task (owner_role, site_id, title, ref_type, ref_id, due_at) VALUES ('AA', $1, 'Relocate a resident', 'emergency_checkin', $2, $3) RETURNING id`, [p.siteId, started.data.caseId, new Date(T0.getTime() - 2 * HOUR)]))[0].id
    expect((await runSweep('emergency_reminders', at(25 * HOUR))).ok).toBe(true)
    expect((await runSweep('emergency_relocation_overdue', at(25 * HOUR))).ok).toBe(true)
    expect((await runSweep('emergency_relocation_overdue', at(25 * HOUR))).ok).toBe(true)
    expectSystemRow(await systemRows('emergency.reminder', started.data.caseId), { type: 'emergency_checkin', site: p.siteId })
    expectSystemRow(await systemRows('emergency.relocation_overdue', taskId), { type: 'task', site: p.siteId })
    const c = (await q<{ status: string; decided_by: string | null }>(`SELECT status, decided_by FROM emergency_checkin WHERE id = $1`, [started.data.caseId]))[0]
    expect(c, 'nobody decided').toMatchObject({ status: 'pending', decided_by: null })
    expect((await q<{ status: string }>(`SELECT status FROM stay WHERE id = $1`, [started.data.stayId]))[0].status, 'nobody was moved').toBe('provisional')
  })
})
