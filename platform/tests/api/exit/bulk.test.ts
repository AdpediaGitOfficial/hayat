/**
 * Bulk exit (D-38): the preview shows a per-row outcome and changes nobody; the confirm re-confirms the password once and works the rows
 * one by one through the same path as a single Mark as Left; a failed row leaves no trace; confirming again only retries what failed.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { admin, call, closeAll, PASSWORD } from '../harness'
import { POST as previewRoute } from '../../../app/api/v1/exit/bulk/preview/route'
import { POST as confirmRoute } from '../../../app/api/v1/exit/bulk/confirm/route'
import { GET as batchRoute } from '../../../app/api/v1/exit/bulk/[id]/route'
import { GET as meRoute } from '../../../app/api/v1/auth/me/route'
import { confirmBulkExit, discardBulkExit, parseEmployeeIds, previewBulkExit } from '@/server/commands/exit/bulk'
import { markLeft } from '@/server/commands/exit/markLeft'
import { auditFor, caseOf, mkItem, resident, snapshot, who, world, type Resident, type World } from './helpers'

afterAll(closeAll)

const date = '2026-10-14'
const preview = (w: World, ids: string[], extra: object = {}) => previewBulkExit(w.aa.rc(), { employeeIds: ids, effectiveDate: date, reason: 'Contract ended, site closed', ...extra })

async function crowd(w: World, n: number): Promise<Resident[]> {
  const out: Resident[] = []
  for (let i = 0; i < n; i++) out.push(await resident({ bedId: w.bedIds[i] }))
  return out
}

describe('reading the list', () => {
  it('takes employee IDs or CSV text (header ignored, first cell used, quotes stripped), without blanks or repeats', () => {
    expect(parseEmployeeIds({ csv: 'employee_id,name\nE1,Ann\n"E2",Bob\n\n E3 ;x\nE1,Ann again\r\nE4' })).toEqual({ ids: ['E1', 'E2', 'E3', 'E4'], duplicates: ['E1'] })
    expect(parseEmployeeIds({ employeeIds: ['A', 'a', ' B '], csv: 'C' })).toEqual({ ids: ['A', 'B', 'C'], duplicates: ['a'] })
    expect(parseEmployeeIds({ csv: '﻿Employee ID\nX9' }).ids).toEqual(['X9'])
  })
})

describe('the preview', () => {
  it('shows will be marked, already left, not found and blocked with the reason, and CHANGES NOBODY', async () => {
    const w = await world()
    const [a, b] = await crowd(w, 2)
    const gone = await resident({ bedId: w.bedIds[2] })
    await markLeft(w.aa.rc(), { staffId: gone.staffId, effectiveDate: date, reason: 'Resigned', confirmPassword: PASSWORD })
    const elsewhere = await resident({ bedId: w.other.bedIds[0] }) // site B: out of scope for this AA
    const before = await Promise.all([a, b].map(r => snapshot(r.staffId, r.user.id)))
    const auditBefore = Number((await admin().query(`SELECT count(*) FROM audit_event WHERE action LIKE 'exit.staff.%' AND entity_id = ANY($1)`, [[a.staffId, b.staffId]])).rows[0].count)

    const res = await preview(w, [a.employeeId, b.employeeId, gone.employeeId, 'NOBODY-HAS-THIS-ID', elsewhere.employeeId])
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const rows = Object.fromEntries(res.data.batch.rows.map(r => [r.employeeId, r]))
    expect(rows[a.employeeId]).toMatchObject({ outcome: 'will_mark', status: 'pending' })
    expect(rows[a.employeeId].message).toMatch(/The stay stays/)
    expect(rows[a.employeeId].message).toMatch(/login ends now/)
    expect(rows[gone.employeeId]).toMatchObject({ outcome: 'already_left', status: 'skipped' })
    expect(rows['NOBODY-HAS-THIS-ID']).toMatchObject({ outcome: 'not_found' })
    expect(rows[elsewhere.employeeId]).toMatchObject({ outcome: 'not_found', message: rows['NOBODY-HAS-THIS-ID'].message }) // out of scope reads exactly like "no such person"
    expect(res.data.batch.counts).toMatchObject({ willMark: 2, alreadyLeft: 1, notFound: 2, blocked: 0, done: 0 })

    // nobody changed, nobody was signed out, no case, no Mark as Left audit
    expect(await Promise.all([a, b].map(r => snapshot(r.staffId, r.user.id)))).toEqual(before)
    expect((await call(meRoute, { cookie: a.cookie })).status).toBe(200)
    expect(await caseOf(a.staffId)).toHaveLength(0)
    expect(Number((await admin().query(`SELECT count(*) FROM audit_event WHERE action LIKE 'exit.staff.%' AND entity_id = ANY($1)`, [[a.staffId, b.staffId]])).rows[0].count)).toBe(auditBefore)
  })

  it('blocked rows say why: yourself, an administrator, a person with an open case, the last Super Admin is covered elsewhere', async () => {
    const w = await world()
    const colleague = await who('AA', { siteIds: [w.siteId] })
    const { mkStayFor } = await import('./helpers')
    await mkStayFor({ staffId: colleague.user.staffId, bedId: w.bedIds[3], from: '2026-10-01' })
    const empOf = async (staffId: string) => (await admin().query<{ employee_id: string }>(`SELECT employee_id FROM staff_profile WHERE id = $1`, [staffId])).rows[0].employee_id
    const self = await empOf(w.aa.user.staffId)
    const res = await preview(w, [self, await empOf(colleague.user.staffId)])
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const rows = Object.fromEntries(res.data.batch.rows.map(r => [r.employeeId, r]))
    expect(rows[self]).toMatchObject({ outcome: 'blocked' })
    expect(rows[self].message).toMatch(/cannot mark yourself/)
    expect(rows[await empOf(colleague.user.staffId)]).toMatchObject({ outcome: 'blocked' })
    expect(rows[await empOf(colleague.user.staffId)].message).toMatch(/only a Super Admin/)
    // a Super Admin may mark the colleague
    const asSa = await previewBulkExit(w.sa.rc(), { employeeIds: [await empOf(colleague.user.staffId)], effectiveDate: date, reason: 'Left the group' })
    expect(asSa.ok && asSa.data.batch.rows[0].outcome).toBe('will_mark')
  })

  it('needs a list, a date and a reason; not more than 200 people', async () => {
    const w = await world()
    expect(await preview(w, [])).toMatchObject({ ok: false, code: 'invalid' })
    expect(await previewBulkExit(w.aa.rc(), { employeeIds: ['E1'], effectiveDate: date, reason: ' ' })).toMatchObject({ ok: false })
    const tooMany = await previewBulkExit(w.aa.rc(), { csv: Array.from({ length: 201 }, (_, i) => `X${i}`).join('\n'), effectiveDate: date, reason: 'Closure' })
    expect(tooMany).toMatchObject({ ok: false, code: 'invalid' })
  })

  it('through the routes: the same checks, Reception and residents are refused (403), and only the creator reads the batch', async () => {
    const w = await world()
    const [a] = await crowd(w, 1)
    const body = { employeeIds: [a.employeeId], effectiveDate: date, reason: 'Contract ended' }
    expect((await call(previewRoute, { cookie: w.rec.cookie, body, path: '/api/v1/exit/bulk/preview' })).status).toBe(403)
    expect((await call(previewRoute, { cookie: a.cookie, body, path: '/api/v1/exit/bulk/preview' })).status).toBe(403)
    const ok = await call(previewRoute, { cookie: w.aa.cookie, body, path: '/api/v1/exit/bulk/preview' })
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    const id = ok.body.data.batchId
    expect((await call(batchRoute, { cookie: w.aa.cookie, params: { id } })).status).toBe(200)
    expect((await call(batchRoute, { cookie: w.sa.cookie, params: { id } })).status).toBe(404) // someone else's preview
    const other = await who('AA', { siteIds: [w.siteId] })
    expect((await call(confirmRoute, { cookie: other.cookie, body: { batchId: id, confirmPassword: PASSWORD }, path: '/api/v1/exit/bulk/confirm' })).status).toBe(404)
    expect(await caseOf(a.staffId)).toHaveLength(0)
  })
})

describe('the confirm', () => {
  it('needs the password; a missing or wrong one changes nobody and leaves the rows pending', async () => {
    const w = await world()
    const people = await crowd(w, 2)
    const p = await preview(w, people.map(r => r.employeeId))
    if (!p.ok) throw new Error(p.reason)
    const before = await Promise.all(people.map(r => snapshot(r.staffId, r.user.id)))
    expect(await confirmBulkExit(w.aa.rc(), { batchId: p.data.batchId })).toMatchObject({ ok: false, code: 'invalid', fields: { confirmPassword: expect.any(String) } })
    expect(await confirmBulkExit(w.aa.rc(), { batchId: p.data.batchId, confirmPassword: 'not-the-password-1' })).toMatchObject({ ok: false, fields: { confirmPassword: 'Wrong password' } })
    expect(await Promise.all(people.map(r => snapshot(r.staffId, r.user.id)))).toEqual(before)
    expect((await admin().query(`SELECT status FROM exit_bulk_batch WHERE id = $1`, [p.data.batchId])).rows[0].status).toBe('previewed')
  })

  it('marks every row through the single path: logins and sessions end, one case each, bulk reason and date used, per-row results', async () => {
    const w = await world()
    const people = await crowd(w, 3)
    const p = await preview(w, people.map(r => r.employeeId))
    if (!p.ok) throw new Error(p.reason)
    const res = await call(confirmRoute, { cookie: w.aa.cookie, body: { batchId: p.data.batchId, confirmPassword: PASSWORD }, path: '/api/v1/exit/bulk/confirm' })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data).toMatchObject({ attempted: 3, marked: 3, failed: 0, alreadyDone: 0 })
    expect(res.body.data.batch).toMatchObject({ status: 'confirmed', counts: { done: 3 } })
    for (const r of people) {
      expect((await call(meRoute, { cookie: r.cookie })).status).toBe(401)
      const cases = await caseOf(r.staffId)
      expect(cases).toHaveLength(1)
      expect(cases[0]).toMatchObject({ effective_date: date, reason: 'Contract ended, site closed', opened_by: w.aa.user.id })
      expect((await auditFor(r.staffId)).filter(a => a.action === 'exit.staff.marked_left')).toHaveLength(1)
    }
    const rows = res.body.data.batch.rows as { status: string; resultMessage: string; caseId: string }[]
    expect(rows.every(x => x.status === 'done' && /Clearance case opened/.test(x.resultMessage))).toBe(true)
    // the stays are untouched (D-35)
    for (const r of people) expect((await admin().query(`SELECT status FROM stay WHERE id = $1`, [r.stayId])).rows[0].status).toBe('active')
  })

  it('is retry-safe: a failed row leaves no trace, a second confirm retries only that row, done rows are skipped', async () => {
    const w = await world()
    const people = await crowd(w, 3)
    const p = await preview(w, people.map(r => r.employeeId))
    if (!p.ok) throw new Error(p.reason)
    const victim = people[1]
    const fn = `gh_fail_${Math.random().toString(36).slice(2, 10)}`
    await admin().query(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$`)
    await admin().query(`CREATE TRIGGER ${fn} BEFORE INSERT ON clearance_case FOR EACH ROW WHEN (NEW.staff_id = '${victim.staffId}') EXECUTE FUNCTION ${fn}()`)
    const victimBefore = await snapshot(victim.staffId, victim.user.id)
    let first
    try { first = await confirmBulkExit(w.aa.rc(), { batchId: p.data.batchId, confirmPassword: PASSWORD }) } finally {
      await admin().query(`DROP TRIGGER ${fn} ON clearance_case`)
      await admin().query(`DROP FUNCTION ${fn}()`)
    }
    expect(first.ok && first.data).toMatchObject({ attempted: 3, marked: 2, failed: 1 })
    expect(first.ok && first.data.batch.status).toBe('partial')
    expect(await snapshot(victim.staffId, victim.user.id)).toBe(victimBefore) // the failed row changed nothing
    expect((await call(meRoute, { cookie: victim.cookie })).status).toBe(200)
    const failedRow = first.ok ? first.data.batch.rows.find(r => r.staffId === victim.staffId)! : undefined
    expect(failedRow).toMatchObject({ status: 'failed', attempts: 1 })
    expect(failedRow?.resultMessage).toBeTruthy()

    const second = await confirmBulkExit(w.aa.rc(), { batchId: p.data.batchId, confirmPassword: PASSWORD })
    expect(second.ok && second.data).toMatchObject({ attempted: 1, marked: 1, failed: 0, alreadyDone: 2 })
    expect(second.ok && second.data.batch.status).toBe('confirmed')
    for (const r of people) expect(await caseOf(r.staffId)).toHaveLength(1) // exactly one case each, never two
    const done = second.ok ? second.data.batch.rows.filter(r => r.staffId !== victim.staffId) : []
    expect(done.every(r => r.attempts === 1)).toBe(true) // the done rows were not touched again
    // and a third time there is nothing to do and no password is needed
    const third = await confirmBulkExit(w.aa.rc(), { batchId: p.data.batchId })
    expect(third.ok && third.data).toMatchObject({ attempted: 0, marked: 0 })
    expect(third.ok && third.message).toMatch(/Nothing left to do/)
  })

  it('two confirms at the same moment still mark everyone exactly once', async () => {
    const w = await world()
    const people = await crowd(w, 4)
    const p = await preview(w, people.map(r => r.employeeId))
    if (!p.ok) throw new Error(p.reason)
    const [x, y] = await Promise.all([
      confirmBulkExit(w.aa.rc(), { batchId: p.data.batchId, confirmPassword: PASSWORD }),
      confirmBulkExit(w.aa.rc(), { batchId: p.data.batchId, confirmPassword: PASSWORD }),
    ])
    expect(x.ok && y.ok).toBe(true)
    for (const r of people) {
      expect(await caseOf(r.staffId)).toHaveLength(1)
      expect((await auditFor(r.staffId)).filter(a => a.action === 'exit.staff.marked_left')).toHaveLength(1)
    }
  })

  it('a row whose person changed between preview and confirm is judged again: someone else marked them first', async () => {
    const w = await world()
    const [a, b] = await crowd(w, 2)
    const p = await preview(w, [a.employeeId, b.employeeId])
    if (!p.ok) throw new Error(p.reason)
    await markLeft(w.sa.rc(), { staffId: a.staffId, effectiveDate: date, reason: 'Resigned (someone else did it)', confirmPassword: PASSWORD })
    const res = await confirmBulkExit(w.aa.rc(), { batchId: p.data.batchId, confirmPassword: PASSWORD })
    expect(res.ok && res.data).toMatchObject({ marked: 1, failed: 1 })
    expect(res.ok && res.data.batch.rows.find(r => r.staffId === a.staffId)?.resultMessage).toMatch(/already marked as Left/)
    expect(await caseOf(a.staffId)).toHaveLength(1)
  })

  it('a preview can be discarded until something was marked; keys held are added to the cases', async () => {
    const w = await world()
    const [a, b] = await crowd(w, 2)
    await mkItem({ siteId: w.siteId, bedId: w.bedIds[1], holderStaffId: b.staffId, code: 'K-BULK' })
    const p1 = await preview(w, [a.employeeId])
    if (!p1.ok) throw new Error(p1.reason)
    expect((await discardBulkExit(w.aa.rc(), { batchId: p1.data.batchId })).ok).toBe(true)
    expect(await confirmBulkExit(w.aa.rc(), { batchId: p1.data.batchId, confirmPassword: PASSWORD })).toMatchObject({ ok: false, code: 'conflict' })
    expect(await caseOf(a.staffId)).toHaveLength(0)
    const p2 = await preview(w, [b.employeeId])
    if (!p2.ok) throw new Error(p2.reason)
    expect((await confirmBulkExit(w.aa.rc(), { batchId: p2.data.batchId, confirmPassword: PASSWORD })).ok).toBe(true)
    expect(await discardBulkExit(w.aa.rc(), { batchId: p2.data.batchId })).toMatchObject({ ok: false, code: 'conflict' })
    const items = (await admin().query(`SELECT label FROM clearance_item i JOIN clearance_case c ON c.id = i.case_id WHERE c.staff_id = $1 AND i.kind = 'handover'`, [b.staffId])).rows
    expect(items).toEqual([{ label: 'Room key K-BULK' }])
  })
})
