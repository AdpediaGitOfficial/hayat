import { afterAll, describe, expect, it } from 'vitest'
import { admin, call, closeAll } from '../harness'
import { mkBed, mkRoom, reserve } from '../fixtures2'
import { claimsOf, count, day, mkProperty, mkRequest, mkStaff, must, notifCount, requestRow, reservationsOf, who } from './helpers'
import { confirmBulkAllocation, discardBulkAllocation, previewBulkAllocation } from '@/server/commands/allocation-admin/bulk'
import { approveRequest } from '@/server/commands/requests/approve'
import { getBulkBatch } from '@/server/queries/requests/bulk'
import { getDb } from '@/server/db/client'
import { POST as previewRoute } from '../../../app/api/v1/requests/bulk/preview/route'
import { POST as confirmRoute } from '../../../app/api/v1/requests/bulk/[id]/confirm/route'

afterAll(closeAll)

async function batchSetup(o: { people?: number; beds?: number } = {}) {
  const p = await mkProperty({ beds: o.beds ?? 3 })
  const aa = await who('AA', { siteIds: [p.siteId] })
  const people = []
  for (let i = 0; i < (o.people ?? 3); i++) {
    const person = await mkStaff({ gender: 'male', grade: 5 })
    const requestId = await mkRequest({ staffId: person.id, siteId: p.siteId, arrival: day(10), end: day(40), createdAt: new Date(Date.UTC(2026, 9, 1, 8, i)) })
    people.push({ person, requestId })
  }
  return { ...p, aa, people }
}
const live = (siteId: string) => count(`SELECT count(*) FROM bed_claim c JOIN bed b ON b.id = c.bed_id WHERE b.site_id = $1 AND c.released_at IS NULL`, [siteId])

describe('bulk allocation preview (D-60)', () => {
  it('matches each request to a distinct eligible free bed and writes NOTHING that reserves: no claim, no reservation, requests unchanged', async () => {
    const t = await batchSetup()
    const out = must(await previewBulkAllocation(t.aa.rc, { siteId: t.siteId }))
    const rows = out.batch.rows
    expect(rows).toHaveLength(3)
    expect(rows.every(r => r.outcome === 'new' && r.status === 'pending' && r.bedId)).toBe(true)
    expect(new Set(rows.map(r => r.bedId)).size).toBe(3) // each bed used once
    expect(out.batch.status).toBe('previewed')
    expect(await live(t.siteId)).toBe(0)
    expect(await count(`SELECT count(*) FROM reservation r JOIN bed b ON b.id = r.bed_id WHERE b.site_id = $1`, [t.siteId])).toBe(0)
    for (const x of t.people) expect((await requestRow(x.requestId)).status).toBe('submitted')
    // previewing again is just another stored preview
    must(await previewBulkAllocation(t.aa.rc, { siteId: t.siteId }))
    expect(await live(t.siteId)).toBe(0)
  })

  it('flags rows that cannot be matched: no free bed (conflict), not eligible (with the exception hint), my own request (SoD), and unknown or request-less people', async () => {
    const p = await mkProperty({ beds: 1 }) // one bed only
    const maleRoom = await mkRoom(p.siteId, { gender: 'male' })
    const maleBed = await mkBed(maleRoom)
    const aa = await who('AA', { siteIds: [p.siteId] })
    const man1 = await mkStaff({ gender: 'male' }); const man2 = await mkStaff({ gender: 'male' })
    const woman = await mkStaff({ gender: 'female' })
    const rq = async (staffId: string, minute: number) => mkRequest({ staffId, siteId: p.siteId, arrival: day(10), end: day(40), createdAt: new Date(Date.UTC(2026, 9, 1, 8, minute)) })
    await reserve(p.bedIds[0], day(5), day(60)) // the general bed is taken
    const r1 = await rq(man1.id, 1)
    const r2 = await rq(man2.id, 2)
    const r3 = await rq(woman.id, 3)
    const mine = await mkRequest({ staffId: aa.staffId, siteId: p.siteId, arrival: day(10), end: day(40) })
    const noReq = await mkStaff()

    const out = must(await previewBulkAllocation(aa.rc, { siteId: p.siteId, employeeIds: [man1.employeeId, man2.employeeId, woman.employeeId, noReq.employeeId, 'NOPE-1'] }))
    void mine
    const byStaff = Object.fromEntries(out.batch.rows.map(r => [r.staffId, r]))
    expect(byStaff[man1.id]).toMatchObject({ outcome: 'new', bedId: maleBed, requestId: r1 })
    expect(byStaff[man2.id]).toMatchObject({ outcome: 'conflict' }) // the one eligible bed is already matched in this batch
    expect(byStaff[man2.id].message).toMatch(/matched to others in this batch/)
    expect(byStaff[woman.id]).toMatchObject({ outcome: 'not_eligible', requestId: r3 })
    expect(byStaff[woman.id].message).toMatch(/male-only/)
    expect(byStaff[woman.id].message).toMatch(/Policy Approver exception/)
    expect(byStaff[noReq.id]).toMatchObject({ outcome: 'no_request', requestId: null, bedId: null })
    expect(out.ignored.join(' ')).toMatch(/NOPE-1/)
    void r2
  })

  it('refuses to allocate for the admin\'s own request and flags a request someone else already moved on', async () => {
    const t = await batchSetup({ people: 1 })
    const ownReq = await mkRequest({ staffId: t.aa.staffId, siteId: t.siteId, arrival: day(10), end: day(40) })
    const waiting = await mkStaff({ gender: 'male' })
    const pending = await mkRequest({ staffId: waiting.id, siteId: t.siteId, arrival: day(10), end: day(40), status: 'pending_approval' })
    const out = must(await previewBulkAllocation(t.aa.rc, { siteId: t.siteId, requestIds: [ownReq, pending, t.people[0].requestId] }))
    const by = Object.fromEntries(out.batch.rows.map(r => [r.requestId, r]))
    expect(by[ownReq]).toMatchObject({ outcome: 'conflict' })
    expect(by[ownReq].message).toMatch(/D-26/)
    expect(by[pending]).toMatchObject({ outcome: 'conflict' })
    expect(by[pending].message).toMatch(/exception/)
    expect(by[t.people[0].requestId].outcome).toBe('new')
  })
})

describe('confirm: per-row transactions through the normal approval path, retry-safe', () => {
  it('reserves every ready row (source bulk), reports per row, and confirming again does nothing more', async () => {
    const t = await batchSetup()
    const { batchId } = must(await previewBulkAllocation(t.aa.rc, { siteId: t.siteId }))
    const done = must(await confirmBulkAllocation(t.aa.rc, { batchId }))
    expect(done).toMatchObject({ attempted: 3, reserved: 3, failed: 0 })
    expect(done.batch.status).toBe('confirmed')
    expect(done.batch.rows.every(r => r.status === 'done' && r.reservationId)).toBe(true)
    for (const x of t.people) {
      const rv = await reservationsOf(x.requestId)
      expect(rv).toHaveLength(1)
      expect(rv[0]).toMatchObject({ source: 'bulk', status: 'reserved' })
      expect((await requestRow(x.requestId)).status).toBe('approved')
      expect(await notifCount(`request:${x.requestId}:approved:resident`)).toBe(1)
    }
    expect(await live(t.siteId)).toBe(3)

    const again = must(await confirmBulkAllocation(t.aa.rc, { batchId }))
    expect(again).toMatchObject({ attempted: 0, reserved: 0, failed: 0, alreadyDone: 3 })
    expect(await live(t.siteId)).toBe(3)
    expect(await count(`SELECT count(*) FROM reservation r JOIN bed b ON b.id = r.bed_id WHERE b.site_id = $1`, [t.siteId])).toBe(3)
  })

  it('a row that fails leaves no trace and is retried alone: done rows are skipped (no duplicates)', async () => {
    const t = await batchSetup()
    const prev = must(await previewBulkAllocation(t.aa.rc, { siteId: t.siteId }))
    const victim = prev.batch.rows[1]
    // between preview and confirm somebody else takes the bed matched to row 2
    const taker = await reserve(victim.bedId!, day(20), day(30))
    const first = must(await confirmBulkAllocation(t.aa.rc, { batchId: prev.batchId }))
    expect(first).toMatchObject({ attempted: 3, reserved: 2, failed: 1 })
    expect(first.batch.status).toBe('partial')
    const failed = first.batch.rows.find(r => r.status === 'failed')!
    expect(failed.id).toBe(victim.id)
    expect(failed.resultMessage).toMatch(/already taken/)
    expect(failed.resultMessage).toMatch(/Next:/)
    expect(failed.attempts).toBe(1)
    expect(await reservationsOf(victim.requestId!)).toHaveLength(0)
    expect((await requestRow(victim.requestId!)).status).toBe('submitted')
    expect(await claimsOf(victim.bedId!)).toHaveLength(1) // only the other person's claim

    // confirm again while still blocked: the same row fails again, the others are untouched
    const second = must(await confirmBulkAllocation(t.aa.rc, { batchId: prev.batchId }))
    expect(second).toMatchObject({ attempted: 1, reserved: 0, failed: 1, alreadyDone: 2 })
    expect(second.batch.rows.find(r => r.id === victim.id)!.attempts).toBe(2)

    // the blocker goes away: only the failed row is retried
    await admin().query(`UPDATE bed_claim SET released_at = now(), release_reason = 'test' WHERE id = $1`, [taker.claimId])
    const third = must(await confirmBulkAllocation(t.aa.rc, { batchId: prev.batchId }))
    expect(third).toMatchObject({ attempted: 1, reserved: 1, failed: 0, alreadyDone: 2 })
    expect(third.batch.status).toBe('confirmed')
    for (const x of t.people) expect(await reservationsOf(x.requestId)).toHaveLength(1)
    for (const x of t.people) expect(await notifCount(`request:${x.requestId}:approved:resident`)).toBe(1)
  })

  it('two simultaneous confirms of the same batch reserve each row exactly once', async () => {
    const t = await batchSetup({ people: 4, beds: 4 })
    const { batchId } = must(await previewBulkAllocation(t.aa.rc, { siteId: t.siteId }))
    const [a, b] = await Promise.all([confirmBulkAllocation(t.aa.rc, { batchId }), confirmBulkAllocation(t.aa.rc, { batchId })])
    expect(a.ok && b.ok).toBe(true)
    for (const x of t.people) expect(await reservationsOf(x.requestId)).toHaveLength(1)
    expect(await live(t.siteId)).toBe(4)
    const view = (await getBulkBatch(getDb(), t.aa.rc.actor, batchId))!
    expect(view.rows.every(r => r.status === 'done')).toBe(true)
  })

  it('a request approved by hand after the preview is picked up as done when the same bed was used, and failed (not duplicated) otherwise', async () => {
    const t = await batchSetup({ people: 2, beds: 3 })
    const { batch, batchId } = must(await previewBulkAllocation(t.aa.rc, { siteId: t.siteId }))
    const [r1, r2] = batch.rows
    const colleague = t.aa // same admin for simplicity: the single approval is the retry-safe path
    must(await approveRequest(colleague.rc, { requestId: r1.requestId!, bedId: r1.bedId! }))
    const other = t.bedIds.find(b => b !== r1.bedId && b !== r2.bedId)!
    must(await approveRequest(colleague.rc, { requestId: r2.requestId!, bedId: other }))
    const out = must(await confirmBulkAllocation(t.aa.rc, { batchId }))
    expect(out.batch.rows.find(r => r.id === r1.id)).toMatchObject({ status: 'done' })
    expect(out.batch.rows.find(r => r.id === r2.id)).toMatchObject({ status: 'failed' })
    expect(await reservationsOf(r1.requestId!)).toHaveLength(1)
    expect(await reservationsOf(r2.requestId!)).toHaveLength(1)
  })

  it('separation of duties still applies in a batch: a row for a request the confirming admin filed on behalf fails, the rest go through', async () => {
    const t = await batchSetup({ people: 2 })
    const prev = must(await previewBulkAllocation(t.aa.rc, { siteId: t.siteId }))
    const filedBy = t.people[0].requestId
    await admin().query(`UPDATE accommodation_request SET on_behalf = true, submitted_by = $2 WHERE id = $1`, [filedBy, t.aa.user.id]) // after the preview
    const out = must(await confirmBulkAllocation(t.aa.rc, { batchId: prev.batchId }))
    expect(out).toMatchObject({ reserved: 1, failed: 1 })
    expect(out.batch.rows.find(r => r.requestId === filedBy)!.resultMessage).toMatch(/filed|behalf/i)
    expect(await reservationsOf(filedBy)).toHaveLength(0)
  })

  it('discard throws a preview away; a discarded or partly confirmed batch cannot be discarded or confirmed wrongly', async () => {
    const t = await batchSetup({ people: 1 })
    const { batchId } = must(await previewBulkAllocation(t.aa.rc, { siteId: t.siteId }))
    must(await discardBulkAllocation(t.aa.rc, { batchId }))
    const c = await confirmBulkAllocation(t.aa.rc, { batchId })
    expect(c.ok).toBe(false)
    expect(await live(t.siteId)).toBe(0)
    const p2 = must(await previewBulkAllocation(t.aa.rc, { siteId: t.siteId }))
    must(await confirmBulkAllocation(t.aa.rc, { batchId: p2.batchId }))
    const late = await discardBulkAllocation(t.aa.rc, { batchId: p2.batchId })
    expect(late.ok).toBe(false)
  })
})

describe('bulk allocation access', () => {
  it('AA/SA only: Reception 403, another site 404 (preview and confirm), and the batch is invisible outside its site', async () => {
    const t = await batchSetup({ people: 1 })
    const rec = await who('Rec', { siteIds: [t.siteId] })
    const outsider = await who('AA', { siteIds: [(await mkProperty()).siteId] })
    expect((await call(previewRoute, { cookie: await rec.cookie(), body: { siteId: t.siteId } })).status).toBe(403)
    expect((await call(previewRoute, { cookie: await outsider.cookie(), body: { siteId: t.siteId } })).status).toBe(404)
    const { batchId } = must(await previewBulkAllocation(t.aa.rc, { siteId: t.siteId }))
    expect((await call(confirmRoute, { cookie: await outsider.cookie(), params: { id: batchId } })).status).toBe(404)
    expect((await call(confirmRoute, { cookie: await rec.cookie(), params: { id: batchId } })).status).toBe(403)
    expect(await getBulkBatch(getDb(), outsider.rc.actor, batchId)).toBeUndefined()
    const sa = await who('SA')
    expect(must(await confirmBulkAllocation(sa.rc, { batchId })).reserved).toBe(1)
    const empty = await previewBulkAllocation(t.aa.rc, { siteId: t.siteId })
    expect(empty.ok).toBe(false) // nothing left to allocate
  })
})
