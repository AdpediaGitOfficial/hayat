/**
 * The cleaning reminder sweep. Sweeps are global and every test file shares one database, so these tests live in their own
 * windows of 1990 (far before every other test's clock and before the real clock): the sweep never reaches another file's tasks.
 * For each boundary: just before, just after, twice, at the same instant, and "it changed no bed and no task".
 */
import { afterAll, describe, expect, it } from 'vitest'
import { admin, closeAll } from '../harness'
import { FixedClock } from '@/server/clock'
import { mkProperty, mkStaff, setBedState } from './helpers'
import { runSweep } from '@/server/jobs/registry'
import '@/server/jobs/sweeps'

afterAll(closeAll)

const HOUR = 3_600_000
const DAYMS = 24 * HOUR
let windowNo = 0
const nextBase = () => Date.UTC(1990, 0, 1, 8, 0, 0) + windowNo++ * 400 * DAYMS
const NAME = 'readiness_cleaning_reminders'

async function world() {
  const p = await mkProperty({ beds: 3 })
  const t0 = nextBase()
  const hk = await mkStaff()
  const mk = async (bedId: string, o: { status: 'open' | 'cleaned'; assigned?: boolean; createdAt?: number; cleanedAt?: number }) => {
    await setBedState(bedId, 'occupied').catch(() => undefined)
    await setBedState(bedId, o.status === 'open' ? 'needs_cleaning' : 'inspection_required')
    return (await admin().query<{ id: string }>(
      `INSERT INTO cleaning_task (bed_id, site_id, reason, status, assigned_to_staff, cleaned_by_staff, cleaned_at, created_at) VALUES ($1, $2, 'Resident checked out', $3, $4, $5, $6, $7) RETURNING id`,
      [bedId, p.siteId, o.status, o.assigned ? hk.id : null, o.status === 'cleaned' ? hk.id : null, o.cleanedAt ? new Date(o.cleanedAt) : null, new Date(o.createdAt ?? t0)])).rows[0].id
  }
  const unassigned = await mk(p.bedIds[0], { status: 'open' })
  const assigned = await mk(p.bedIds[1], { status: 'open', assigned: true })
  const cleaned = await mk(p.bedIds[2], { status: 'cleaned', assigned: true, cleanedAt: t0 })
  return { ...p, t0, tasks: { unassigned, assigned, cleaned }, ids: [unassigned, assigned, cleaned] }
}
type W = Awaited<ReturnType<typeof world>>

const sweep = (at: number) => runSweep(NAME, new FixedClock(at))
const keys = async (w: W) => (await admin().query<{ dedupe_key: string; to_role: string; text: string; site_id: string }>(
  `SELECT dedupe_key, to_role, text, site_id FROM notification WHERE kind LIKE 'cleaning.sla%' AND ref_id = ANY($1) ORDER BY dedupe_key`, [w.ids])).rows
async function snapshot(w: W) {
  return {
    tasks: (await admin().query(`SELECT * FROM cleaning_task WHERE site_id = $1 ORDER BY id`, [w.siteId])).rows,
    beds: (await admin().query(`SELECT id, state, state_reason, state_since, updated_at FROM bed WHERE site_id = $1 ORDER BY id`, [w.siteId])).rows,
    claims: (await admin().query(`SELECT count(*)::int AS n FROM bed_claim WHERE bed_id = ANY($1)`, [w.bedIds])).rows,
  }
}

describe('cleaning SLA sweep (readiness.cleaning_sla_hours = 24)', () => {
  it('nothing just before the SLA', async () => {
    const w = await world()
    const r = await sweep(w.t0 + 24 * HOUR - 1000)
    expect(r.ok).toBe(true)
    expect(await keys(w)).toHaveLength(0)
  })

  it('just after: Reception is reminded once per task and stage; the Admin is not yet; the reminder says why', async () => {
    const w = await world()
    expect((await sweep(w.t0 + 24 * HOUR)).ok).toBe(true)
    const k = await keys(w)
    expect(k.map(x => x.dedupe_key).sort()).toEqual([
      `cleaning:${w.tasks.assigned}:sla:open:rec`, `cleaning:${w.tasks.cleaned}:sla:cleaned:rec`, `cleaning:${w.tasks.unassigned}:sla:open:rec`,
    ].sort())
    expect(k.every(x => x.to_role === 'Rec' && x.site_id === w.siteId)).toBe(true)
    const text = (id: string) => k.find(x => x.dedupe_key.includes(id))!.text
    expect(text(w.tasks.unassigned)).toContain('no housekeeper assigned')
    expect(text(w.tasks.assigned)).toContain('still not cleaned')
    expect(text(w.tasks.cleaned)).toContain('waited for the final inspection')
    // And a system audit row for each, without a user.
    const a = await admin().query(`SELECT actor_user_id, actor_role FROM audit_event WHERE action = 'readiness.cleaning.sla_reminder' AND entity_id = ANY($1)`, [w.ids])
    expect(a.rowCount).toBe(3)
    expect(a.rows.every(x => x.actor_user_id === null && x.actor_role === 'system')).toBe(true)
  })

  it('the Accommodation Admin is told once after the second period, and not before', async () => {
    const w = await world()
    await sweep(w.t0 + 24 * HOUR)
    await sweep(w.t0 + 48 * HOUR - 1000)
    expect((await keys(w)).filter(x => x.to_role === 'AA')).toHaveLength(0)
    await sweep(w.t0 + 48 * HOUR)
    const aa = (await keys(w)).filter(x => x.to_role === 'AA')
    expect(aa.map(x => x.dedupe_key).sort()).toEqual([`cleaning:${w.tasks.assigned}:sla:open:aa`, `cleaning:${w.tasks.cleaned}:sla:cleaned:aa`, `cleaning:${w.tasks.unassigned}:sla:open:aa`].sort())
    await sweep(w.t0 + 72 * HOUR)
    await sweep(w.t0 + 30 * DAYMS)
    expect(await keys(w)).toHaveLength(6) // three tasks, Reception once and the Admin once each, however long it goes on
  })

  it('a sweep that wakes up late sends both reminders at once, once', async () => {
    const w = await world()
    await sweep(w.t0 + 5 * DAYMS)
    await sweep(w.t0 + 5 * DAYMS)
    expect(await keys(w)).toHaveLength(6)
  })

  it('twice, and two runners at the same instant: the same notifications and audit rows, no duplicates', async () => {
    const w = await world()
    const at = w.t0 + 49 * HOUR
    const runs = await Promise.all([sweep(at), sweep(at), sweep(at)])
    expect(runs.every(r => r.ok)).toBe(true)
    await sweep(at)
    expect(await keys(w)).toHaveLength(6)
    const audits = await admin().query(`SELECT action FROM audit_event WHERE action LIKE 'readiness.cleaning.sla_%' AND entity_id = ANY($1)`, [w.ids])
    expect(audits.rowCount).toBe(6)
  })

  it('NEVER assigns, cleans, inspects, cancels or releases a bed: every task and bed row is untouched, and no claim is made', async () => {
    const w = await world()
    const before = await snapshot(w)
    await sweep(w.t0 + 25 * HOUR)
    await sweep(w.t0 + 100 * DAYMS)
    expect(await snapshot(w)).toEqual(before)
    const states = (await admin().query(`SELECT state FROM bed WHERE site_id = $1 ORDER BY state`, [w.siteId])).rows.map(r => r.state)
    expect(states).toEqual(['inspection_required', 'needs_cleaning', 'needs_cleaning'])
  })

  it('measures each stage from its own start: a task cleaned an hour ago is not late just because it was opened days ago', async () => {
    const w = await world()
    const t = w.t0 + 10 * DAYMS
    await admin().query(`UPDATE cleaning_task SET created_at = $2, cleaned_at = $3 WHERE id = $1`, [w.tasks.cleaned, new Date(w.t0), new Date(t - HOUR)])
    await sweep(t)
    expect((await keys(w)).filter(x => x.dedupe_key.includes(w.tasks.cleaned))).toHaveLength(0)
    await sweep(t + 23 * HOUR)
    expect((await keys(w)).filter(x => x.dedupe_key.includes(w.tasks.cleaned)).map(x => x.to_role)).toEqual(['Rec'])
  })

  it('a finished task is not reminded about (passed, failed, cancelled, or no longer open when the sweep gets to it)', async () => {
    const w = await world()
    await admin().query(`UPDATE cleaning_task SET status = 'cancelled' WHERE id = $1`, [w.tasks.unassigned])
    await admin().query(`UPDATE cleaning_task SET status = 'passed', inspected_by_staff = $2 WHERE id = $1`, [w.tasks.cleaned, (await mkStaff()).id])
    await sweep(w.t0 + 3 * DAYMS)
    expect((await keys(w)).map(x => x.dedupe_key).sort()).toEqual([`cleaning:${w.tasks.assigned}:sla:open:aa`, `cleaning:${w.tasks.assigned}:sla:open:rec`].sort())
  })
})
