/**
 * The overdue clearance sweep: an open case past its due date tells the Accommodation Admin once; after the configured business days
 * it tells the Policy Approver once; it NEVER closes, completes or waives anything. Boundary before and after, twice, concurrently.
 * Runs in a private database: sweeps look at every case, and the shared test database is used by every test file at once.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { createIsolated } from '../access/isolated'
import { FixedClock } from '@/server/clock'
import { getDb } from '@/server/db/client'
import { listSweeps, runSweep } from '@/server/jobs/registry'
import '@/server/jobs/sweeps'

const iso = await createIsolated()
afterAll(async () => {
  // pg-pool's end() resolves before the sockets are closed, and close() then drops the database WITH (FORCE): wait for the sockets first,
  // or the dying connections raise "terminating connection" as an unhandled error (a race in tests/api/access/isolated.ts).
  const end = iso.admin.end.bind(iso.admin)
  iso.admin.end = (async () => { await end(); await new Promise(r => setTimeout(r, 250)) }) as typeof iso.admin.end
  await iso.close()
})

const NAME = 'exit_clearance_overdue'
const at = (iso8: string) => new FixedClock(new Date(iso8))
const uniq = (p: string) => `${p}-${randomUUID().slice(0, 8)}`

async function mkCase(o: { due?: string; status?: string; tz?: string; noSite?: boolean } = {}) {
  const site = o.noSite ? null : (await iso.admin.query<{ id: string }>(`INSERT INTO site (code, name, kind, time_zone) VALUES ($1, 'Sweep site', 'villa', $2) RETURNING id`, [uniq('S'), o.tz ?? 'UTC'])).rows[0].id
  const staff = (await iso.admin.query<{ id: string }>(`INSERT INTO staff_profile (employee_id, full_name, employment_status, left_at) VALUES ($1, $2, 'left', now()) RETURNING id`, [uniq('E'), 'Leaver ' + uniq('P')])).rows[0].id
  const opener = (await iso.makeUser({ roles: [{ role: 'SA', all: true }] })).id
  const status = o.status ?? 'open'
  const k = (await iso.admin.query<{ id: string }>(
    `INSERT INTO clearance_case (staff_id, site_id, effective_date, reason, status, opened_by, opened_at, due_date, cleared_by, cleared_at)
     VALUES ($1, $2, '2026-10-14', 'Resigned', $3, $4, '2026-10-14T09:42:00Z', $5, CASE WHEN $3 = 'cleared' THEN $4::uuid END, CASE WHEN $3 = 'cleared' THEN now() END) RETURNING id`,
    [staff, site, status, opener, o.due ?? '2026-10-21'])).rows[0].id
  await iso.admin.query(`INSERT INTO clearance_item (case_id, kind, checklist_key, label, mandatory, owner, position) VALUES ($1, 'checklist', 'belongings', 'Belongings removed', true, 'Reception', 1)`, [k])
  return { id: k, siteId: site, staffId: staff }
}
const notes = async (caseId: string) => (await iso.admin.query<{ dedupe_key: string; to_role: string; site_id: string | null; critical: boolean }>(
  `SELECT dedupe_key, to_role, site_id, critical FROM notification WHERE ref_type = 'clearance_case' AND ref_id = $1 AND dedupe_key LIKE 'clearance:%' ORDER BY dedupe_key`, [caseId])).rows
const audits = async (caseId: string) => (await iso.admin.query<{ action: string }>(`SELECT action FROM audit_event WHERE entity_id = $1 ORDER BY seq`, [caseId])).rows.map(r => r.action)
const caseState = async (id: string) => JSON.stringify([
  (await iso.admin.query(`SELECT status, cleared_at FROM clearance_case WHERE id = $1`, [id])).rows,
  (await iso.admin.query(`SELECT status, done_by, waived_by FROM clearance_item WHERE case_id = $1 ORDER BY position`, [id])).rows,
])
const sweepNow = (c: FixedClock) => runSweep(NAME, c)

describe('the overdue clearance sweep', () => {
  it('is registered', () => { expect(listSweeps().map(s => s.name)).toContain(NAME) })

  it('does nothing on the due date itself (23:59:59) and tells the Accommodation Admin from the next day, once', async () => {
    const k = await mkCase({ due: '2026-10-21' })
    expect((await sweepNow(at('2026-10-21T23:59:59Z'))).ok).toBe(true)
    expect(await notes(k.id)).toHaveLength(0)
    expect((await sweepNow(at('2026-10-22T00:00:00Z'))).ok).toBe(true)
    const n = await notes(k.id)
    expect(n).toEqual([{ dedupe_key: `clearance:${k.id}:overdue`, to_role: 'AA', site_id: k.siteId, critical: false }])
    expect(await audits(k.id)).toEqual(['exit.clearance.overdue_flagged'])
  })

  it('escalates to the Policy Approver after the configured business days (default 2), not before, and weekends do not count', async () => {
    const k = await mkCase({ due: '2026-10-21' })
    await sweepNow(at('2026-10-22T09:00:00Z')) // Thursday: 1 business day late
    expect((await notes(k.id)).map(x => x.to_role)).toEqual(['AA'])
    await sweepNow(at('2026-10-23T09:00:00Z')) // Friday: 2 business days late -> escalated
    const n = await notes(k.id)
    expect(n.map(x => [x.dedupe_key.split(':').pop(), x.to_role, x.critical])).toEqual([['escalated', 'PolicyApprover', true], ['overdue', 'AA', false]])
    expect(n[0].site_id).toBe(k.siteId)
    expect(await audits(k.id)).toEqual(['exit.clearance.overdue_flagged', 'exit.clearance.overdue_escalated'])

    const weekend = await mkCase({ due: '2026-10-22' }) // Thursday
    await sweepNow(at('2026-10-24T09:00:00Z')) // Saturday: 1 business day (Friday) late
    expect((await notes(weekend.id)).map(x => x.to_role)).toEqual(['AA'])
    await sweepNow(at('2026-10-25T09:00:00Z')) // Sunday: still 1
    expect((await notes(weekend.id)).map(x => x.to_role)).toEqual(['AA'])
    await sweepNow(at('2026-10-26T09:00:00Z')) // Monday: 2
    expect((await notes(weekend.id)).map(x => x.to_role).sort()).toEqual(['AA', 'PolicyApprover'])
  })

  it('follows the site time zone: it is the next day in Auckland while it is still the due date in UTC', async () => {
    const auckland = await mkCase({ due: '2026-10-21', tz: 'Pacific/Auckland' })
    const utc = await mkCase({ due: '2026-10-21', tz: 'UTC' })
    await sweepNow(at('2026-10-21T11:30:00Z')) // 00:30 on the 22nd in Auckland (UTC+13 in October)
    expect((await notes(auckland.id)).length).toBe(1)
    expect((await notes(utc.id)).length).toBe(0)
  })

  it('runs twice and runs at the same moment without doubling anything (one notification, one audit row)', async () => {
    const k = await mkCase({ due: '2026-10-21' })
    const clock = at('2026-10-24T09:00:00Z') // late enough for both steps
    const sweep = listSweeps().find(s => s.name === NAME)!
    const ctx = () => ({ clock, now: clock.now(), db: getDb(), requestId: 'test-sweep' })
    await Promise.all([sweep.run(ctx()), sweep.run(ctx()), sweep.run(ctx())])
    await sweepNow(clock)
    await sweepNow(clock)
    expect((await notes(k.id)).map(x => x.to_role).sort()).toEqual(['AA', 'PolicyApprover'])
    expect(await audits(k.id)).toEqual(['exit.clearance.overdue_flagged', 'exit.clearance.overdue_escalated'])
  })

  it('NEVER closes, completes or waives anything, however late it is, and never touches a stay or a bed', async () => {
    const k = await mkCase({ due: '2026-09-01', status: 'pending_items' })
    const before = await caseState(k.id)
    await sweepNow(at('2027-03-01T09:00:00Z'))
    expect(await caseState(k.id)).toBe(before)
    expect((await audits(k.id)).filter(a => /cleared|item_done|item_waived|waived|closed/.test(a))).toEqual([])
    const stays = (await iso.admin.query(`SELECT count(*)::int AS n FROM stay WHERE staff_id = $1`, [k.staffId])).rows[0].n
    expect(stays).toBe(0)
  })

  it('leaves a cleared case alone, and tells any Accommodation Admin when the case has no site', async () => {
    const cleared = await mkCase({ due: '2026-09-01', status: 'cleared' })
    const noSite = await mkCase({ due: '2026-09-01', noSite: true })
    await sweepNow(at('2026-10-30T09:00:00Z'))
    expect(await notes(cleared.id)).toHaveLength(0)
    expect((await notes(noSite.id)).map(x => [x.to_role, x.site_id])).toEqual([['PolicyApprover', null], ['AA', null]])
  })

  it('the escalation delay is configuration: with 0 days both go out on the first overdue day', async () => {
    await iso.admin.query(`INSERT INTO config_item (key, version, value) VALUES ('clearance.escalate_after_business_days', COALESCE((SELECT max(version) FROM config_item WHERE key = 'clearance.escalate_after_business_days'), 0) + 1, '0'::jsonb)`)
    try {
      const k = await mkCase({ due: '2026-10-21' })
      await sweepNow(at('2026-10-22T00:00:00Z'))
      expect((await notes(k.id)).map(x => x.to_role).sort()).toEqual(['AA', 'PolicyApprover'])
    } finally {
      await iso.admin.query(`INSERT INTO config_item (key, version, value) VALUES ('clearance.escalate_after_business_days', (SELECT max(version) FROM config_item WHERE key = 'clearance.escalate_after_business_days') + 1, '2'::jsonb)`)
    }
  })
})
