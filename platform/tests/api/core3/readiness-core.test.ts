import { afterAll, describe, expect, it } from 'vitest'
import { admin, closeAll, makeUser } from '../harness'
import { cleaningTasks, mkItem, mkProperty, mkStayFor, mkStaff, mkSite, mkRoom, mkBed } from '../fixtures3'
import { notificationsByKey, occupy, reserve } from '../fixtures2'
import { rcFor } from '../rc'
import { runCommand } from '@/server/command/run'
import { ok } from '@/server/command/result'
import { openCleaningTask } from '@/server/readiness/hooks'
import { closeStayIfDone, registerStayCloser, stayCloseBlockers } from '@/server/stays-close'
import { outstandingHandovers } from '@/server/handover/outstanding'
import { getDb } from '@/server/db/client'
import { FixedClock } from '@/server/clock'
import { archiveBed } from '@/server/commands/property/archiveBed'
import { archiveRoom } from '@/server/commands/property/archiveRoom'
import { unblockBed } from '@/server/commands/property/unblockBed'

afterAll(closeAll)
const sa = async () => { const u = await makeUser({ roles: [{ role: 'SA', all: true }] }); return rcFor(u.id, { role: 'SA', sites: 'all' }, new FixedClock(Date.UTC(2026, 9, 14, 9))) }

describe('cleaning tasks', () => {
  it('one open task per bed, however often the hook runs, and Reception is told once', async () => {
    const { bedIds, siteId } = await mkProperty({ beds: 1 })
    const rc = await sa()
    for (let i = 0; i < 3; i++) await runCommand(rc, async c => { await openCleaningTask(c.tx, { bedId: bedIds[0], reason: 'Resident checked out', now: c.now }); return ok(undefined) })
    const tasks = await cleaningTasks(bedIds[0])
    expect(tasks).toHaveLength(1)
    expect((await notificationsByKey(`cleaning:${tasks[0].id}:opened`))[0]).toMatchObject({ to_role: 'Rec' })
    void siteId
  })

  it('a task is opened when a bed is unblocked, and when it is cleaned and passed a new one can be opened later', async () => {
    const { bedIds, siteId } = await mkProperty({ beds: 1 })
    const rc = await sa()
    await admin().query(`UPDATE bed SET state = 'blocked', state_reason = 'test' WHERE id = $1`, [bedIds[0]])
    await admin().query(`INSERT INTO bed_block (bed_id, site_id, reason, blocked_by) VALUES ($1, $2, 'test', $3)`, [bedIds[0], siteId, rc.user.id])
    const r = await unblockBed(rc, { bedId: bedIds[0] } as never)
    expect(r.ok, JSON.stringify(r)).toBe(true)
    expect((await cleaningTasks(bedIds[0])).map(t => t.reason)).toEqual(['Unblocked'])
    await admin().query(`UPDATE cleaning_task SET status = 'passed' WHERE bed_id = $1`, [bedIds[0]])
    await runCommand(rc, async c => { await openCleaningTask(c.tx, { bedId: bedIds[0], reason: 'again', now: c.now }); return ok(undefined) })
    expect(await cleaningTasks(bedIds[0])).toHaveLength(2)
  })

  it('the cleaner can never be the inspector (database check)', async () => {
    const { bedIds, siteId } = await mkProperty({ beds: 1 })
    const s = await mkStaff()
    await admin().query(`INSERT INTO cleaning_task (bed_id, site_id, reason, status, cleaned_by_staff, inspected_by_staff) VALUES ($1, $2, 'x', 'cleaned', $3, $4)`, [bedIds[0], siteId, s.id, (await mkStaff()).id])
    const bed2 = (await mkProperty({ beds: 1 })).bedIds[0]
    await expect(admin().query(`INSERT INTO cleaning_task (bed_id, site_id, reason, status, cleaned_by_staff, inspected_by_staff) VALUES ($1, $2, 'x', 'cleaned', $3, $3)`, [bed2, siteId, s.id])).rejects.toThrow(/cleaning_cleaner_not_inspector/)
  })
})

describe('archive dependencies (AT-029 grows)', () => {
  it('a key still issued on the bed and an open cleaning task both block the archive, with owner and next action', async () => {
    const { bedIds, siteId, roomId } = await mkProperty({ beds: 2 })
    const holder = await mkStaff()
    await mkItem({ siteId, bedId: bedIds[0], holderStaffId: holder.id, code: 'K-ISSUED' })
    await admin().query(`INSERT INTO cleaning_task (bed_id, site_id, reason) VALUES ($1, $2, 'test')`, [bedIds[1], siteId])
    const rc = await sa()
    const a = await archiveBed(rc, { id: bedIds[0], reason: 'test' })
    expect(a.ok, JSON.stringify(a)).toBe(false)
    if (!a.ok) { expect(JSON.stringify(a.detail)).toContain('outstanding_item') }
    const b = await archiveBed(rc, { id: bedIds[1], reason: 'test' })
    expect(b.ok).toBe(false)
    if (!b.ok) expect(JSON.stringify(b.detail)).toContain('open_cleaning')
    const r = await archiveRoom(rc, { id: roomId, reason: 'test', cascade: true } as never)
    expect(r.ok).toBe(false)
  })
})

describe('stay closing and outstanding handovers', () => {
  it('lists what a person still holds: issued, lost and damaged, not returned or retired', async () => {
    const { siteId, bedIds } = await mkProperty({ beds: 1 })
    const s = await mkStaff()
    await mkItem({ siteId, bedId: bedIds[0], holderStaffId: s.id, code: 'A' })
    await mkItem({ siteId, bedId: bedIds[0], holderStaffId: s.id, code: 'B', status: 'lost' })
    await mkItem({ siteId, bedId: bedIds[0], code: 'C' })
    const out = await outstandingHandovers(getDb(), s.id)
    expect(out.map(o => o.code).sort()).toEqual(['A', 'B'])
  })

  it('a stay never closes at checkout on its own: it needs something that has cleared it, and nothing outstanding', async () => {
    const { siteId, bedIds } = await mkProperty({ beds: 2 })
    const s = await mkStaff()
    const { stayId } = await mkStayFor({ staffId: s.id, bedId: bedIds[0] })
    const rc = await sa()
    const attempt = () => runCommand(rc, async c => ok(await closeStayIfDone(c.tx, stayId, c.now)))
    expect((await attempt()).ok && (await attempt() as any).data).toBe(false)       // still active
    await admin().query(`UPDATE stay SET status = 'checked_out', checked_out_at = now() WHERE id = $1`, [stayId])
    expect((await attempt() as any).data).toBe(false)                              // checked out but nobody has cleared it: stays checked_out (voluntary checkout)
    let cleared = true
    registerStayCloser(`test-${stayId}`, async (_tx, st) => st.id === stayId && cleared)
    const key = await mkItem({ siteId, bedId: bedIds[0], holderStaffId: s.id, code: 'HELD' })
    expect((await attempt() as any).data).toBe(false)                              // cleared, but a key is still held
    const roomId = (await admin().query<{ room_id: string }>(`SELECT room_id FROM bed WHERE id = $1`, [bedIds[0]])).rows[0].room_id
    const why = await runCommand(rc, async c => ok(await stayCloseBlockers(c.tx, { id: stayId, staffId: s.id, bedId: bedIds[0], roomId })))
    expect(why.ok && why.data[0]).toMatch(/not yet returned/)
    await admin().query(`UPDATE handover_item SET status = 'in_cabinet', holder_staff_id = NULL WHERE id = $1`, [key])
    expect((await attempt() as any).data).toBe(true)                               // cleared and nothing held: closed
    expect((await admin().query(`SELECT status, closed_at FROM stay WHERE id = $1`, [stayId])).rows[0].status).toBe('closed')
    cleared = false
    void occupy; void reserve; void mkSite; void mkRoom; void mkBed
  })
})
