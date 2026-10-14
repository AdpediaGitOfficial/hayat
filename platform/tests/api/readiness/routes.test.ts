import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { admin, call, closeAll } from '../harness'
import { day, FULL, housekeeper, inspector, mkStay, scene, staffAt, vacate, type Scene } from './helpers'
import { PNG as PNG_BYTES } from '../fixtures3'
import { LocalStore, setStore } from '@/server/attachments'
import { GET as board } from '../../../app/api/v1/readiness/board/route'
import { GET as mine } from '../../../app/api/v1/readiness/mine/route'
import { GET as queue } from '../../../app/api/v1/readiness/inspections/route'
import { GET as housekeepers } from '../../../app/api/v1/readiness/housekeepers/route'
import { POST as assign } from '../../../app/api/v1/readiness/tasks/[id]/assign/route'
import { POST as clean } from '../../../app/api/v1/readiness/tasks/[id]/clean/route'
import { POST as pass } from '../../../app/api/v1/readiness/tasks/[id]/pass/route'
import { POST as failRoute } from '../../../app/api/v1/readiness/tasks/[id]/fail/route'
import { POST as cancel } from '../../../app/api/v1/readiness/tasks/[id]/cancel/route'
import { POST as upload, GET as listFiles } from '../../../app/api/v1/attachments/route'

afterAll(closeAll)
beforeAll(async () => { setStore(new LocalStore(await mkdtemp(path.join(tmpdir(), 'gh-ready-')))) })

const get = (h: Parameters<typeof call>[0], cookie: string, qs = '') => call(h, { method: 'GET', cookie, path: `/api/v1/readiness/x${qs}` })
const act = (h: Parameters<typeof call>[0], cookie: string, id: string, body: unknown = {}) => call(h, { method: 'POST', cookie, params: { id }, body, path: `/api/v1/readiness/tasks/${id}/x` })

async function staffed() {
  const s = await scene({ beds: 4 })
  const v1 = await vacate(s, s.bedIds[0])
  const v2 = await vacate(s, s.bedIds[1])
  const cookies = { rec: await s.rec.cookie(), sa: await s.sa.cookie(), hk: await s.hk.cookie(), insp: await s.insp.cookie() }
  return { ...s, v1, v2, cookies }
}

describe('the board', () => {
  it('Reception sees every bed that is not ready with its task, assignee, age, owner and next action in words (D-93)', async () => {
    const s = await staffed()
    const empty = await get(board, s.cookies.rec, `?siteId=${s.siteId}`)
    expect(empty.status, JSON.stringify(empty.body)).toBe(200)
    const rows = empty.body.data.rows as any[]
    expect(rows.map(r => r.bedId).sort()).toEqual([s.bedIds[0], s.bedIds[1]].sort())
    const r0 = rows.find(r => r.bedId === s.bedIds[0])
    expect(r0).toMatchObject({ state: 'needs_cleaning', label: 'Vacant, awaiting cleaning assignment', owner: 'Reception', next: 'Assign a housekeeper', task: { id: s.v1.taskId, status: 'open', assigneeName: null, reason: 'Resident checked out' } })
    expect(empty.body.data.summary).toMatchObject({ needsCleaning: 2, unassigned: 2, awaitingInspection: 0 })

    expect((await act(assign, s.cookies.rec, s.v1.taskId, { housekeeperStaffId: s.hk.staffId })).status).toBe(200)
    const assigned = (await get(board, s.cookies.rec)).body.data.rows.find((r: any) => r.bedId === s.bedIds[0])
    expect(assigned).toMatchObject({ label: 'Vacant, being cleaned', owner: expect.stringContaining('Person'), next: 'Clean the room and tick the checklist', task: { assigneeStaffId: s.hk.staffId } })

    expect((await act(clean, s.cookies.hk, s.v1.taskId, { checklist: FULL })).status).toBe(200)
    const cleaned = (await get(board, s.cookies.rec)).body.data.rows.find((r: any) => r.bedId === s.bedIds[0])
    expect(cleaned).toMatchObject({ state: 'inspection_required', label: 'Vacant, awaiting final inspection', owner: 'Final Inspection holder', next: 'Inspect the room, then pass or fail it', task: { status: 'cleaned' } })

    expect((await act(pass, s.cookies.insp, s.v1.taskId, {})).status).toBe(200)
    const after = (await get(board, s.cookies.rec)).body.data
    expect(after.rows.map((r: any) => r.bedId)).toEqual([s.bedIds[1]]) // the passed bed has left the board: it is Available
  })

  it('shows blocked and under-maintenance beds with their reason and owner, but they are not the readiness team\'s to change', async () => {
    const s = await staffed()
    await admin().query(`UPDATE bed SET state = 'blocked', state_reason = 'Burst pipe' WHERE id = $1`, [s.bedIds[2]])
    await admin().query(`UPDATE bed SET state = 'under_maintenance' WHERE id = $1`, [s.bedIds[3]])
    const rows = (await get(board, s.cookies.rec)).body.data.rows as any[]
    expect(rows.find(r => r.bedId === s.bedIds[2])).toMatchObject({ state: 'blocked', label: 'Blocked: Burst pipe', owner: 'Maintenance Coordinator', task: null })
    expect(rows.find(r => r.bedId === s.bedIds[3])).toMatchObject({ state: 'under_maintenance', owner: 'Maintenance Coordinator' })
  })

  it('a booked arrival makes a bed more urgent (needBy) and sorts it first', async () => {
    const s = await staffed()
    await admin().query(`INSERT INTO bed_claim (bed_id, kind, period) VALUES ($1, 'reservation', $2::daterange)`, [s.bedIds[1], `[${day(1)},${day(30)})`])
    const rows = (await get(board, s.cookies.rec)).body.data.rows as any[]
    expect(rows[0]).toMatchObject({ bedId: s.bedIds[1], needBy: day(1) })
  })

  it('the Super Admin and the Maintenance Coordinator see the rows; the Manager and the Auditor see a summary with no rows and no names', async () => {
    const s = await staffed()
    await act(assign, s.cookies.rec, s.v1.taskId, { housekeeperStaffId: s.hk.staffId })
    const mc = await (await staffAt('MC', s.siteId)).cookie()
    expect((await get(board, mc)).body.data.rows).toHaveLength(2)
    expect((await get(board, s.cookies.sa, `?siteId=${s.siteId}`)).body.data.rows).toHaveLength(2)
    for (const role of ['Mgr', 'Aud'] as const) {
      const r = await get(board, await (await staffAt(role, s.siteId)).cookie())
      expect(r.status).toBe(200)
      expect(r.body.data.rows).toBeNull()
      expect(r.body.data.summary).toMatchObject({ needsCleaning: 2, unassigned: 1 })
      const text = JSON.stringify(r.body)
      expect(text).not.toContain(s.hk.user.username)
      expect(text).not.toContain('Person ')
      expect(text).not.toContain(s.hk.staffId)
    }
  })

  it('scope: Reception of another site sees none of it (and gets 404 acting on it); a housekeeper has no board (403) and a resident no access', async () => {
    const s = await staffed()
    const other = await scene({ beds: 1 })
    const foreign = await get(board, await other.rec.cookie())
    expect(foreign.status).toBe(200)
    expect(foreign.body.data.rows).toEqual([])
    expect(JSON.stringify(foreign.body)).not.toContain(s.bedIds[0])
    for (const [h, body] of [[assign, { housekeeperStaffId: s.hk.staffId }], [cancel, { reason: 'because' }]] as const) {
      const r = await act(h, await other.rec.cookie(), s.v1.taskId, body)
      expect(r.status).toBe(404)
    }
    expect((await act(pass, await other.insp.cookie(), s.v1.taskId, {})).status).toBe(404)
    expect((await get(board, s.cookies.hk)).status).toBe(403)
    const res = await (await staffAt('Res', null)).cookie()
    expect((await get(board, res)).status).toBe(403)
    expect((await get(mine, res)).status).toBe(403)
    expect((await get(queue, s.cookies.rec)).status).toBe(403)
    expect((await get(housekeepers, s.cookies.hk)).status).toBe(403)
  })
})

describe('my rooms (job scope)', () => {
  it('a housekeeper sees only the open tasks assigned to them: not other housekeepers\' tasks, not unassigned ones, not a cleaned one', async () => {
    const s = await staffed()
    const v3 = await vacate(s, s.bedIds[2])
    const other = await housekeeper()
    await act(assign, s.cookies.rec, s.v1.taskId, { housekeeperStaffId: s.hk.staffId })
    await act(assign, s.cookies.rec, s.v2.taskId, { housekeeperStaffId: other.staffId })
    await act(assign, s.cookies.rec, v3.taskId, { housekeeperStaffId: s.hk.staffId })
    const m = await get(mine, s.cookies.hk)
    expect(m.status).toBe(200)
    expect((m.body.data.rooms as any[]).map(r => r.taskId).sort()).toEqual([s.v1.taskId, v3.taskId].sort())
    expect(m.body.data.checklist.map((l: any) => l.id)).toEqual(['linen', 'surfaces', 'bathroom', 'bins', 'damage'])
    expect(JSON.stringify(m.body)).not.toContain(s.v2.taskId)
    await act(clean, s.cookies.hk, s.v1.taskId, { checklist: FULL })
    expect(((await get(mine, s.cookies.hk)).body.data.rooms as any[]).map(r => r.taskId)).toEqual([v3.taskId])
    // The other housekeeper cannot reach it by id, and Reception cannot clean it.
    expect((await act(clean, await other.cookie(), v3.taskId, { checklist: FULL })).status).toBe(404)
    expect((await act(clean, s.cookies.rec, v3.taskId, { checklist: FULL })).status).toBe(403)
  })

  it('a redo shows what the inspector said was wrong', async () => {
    const s = await staffed()
    await act(assign, s.cookies.rec, s.v1.taskId, { housekeeperStaffId: s.hk.staffId })
    await act(clean, s.cookies.hk, s.v1.taskId, { checklist: FULL })
    const f = await act(failRoute, s.cookies.insp, s.v1.taskId, { note: 'Streaks on the mirror' })
    expect(f.status, JSON.stringify(f.body)).toBe(200)
    await act(assign, s.cookies.rec, f.body.data.newTaskId, { housekeeperStaffId: s.hk.staffId })
    const room = ((await get(mine, s.cookies.hk)).body.data.rooms as any[])[0]
    expect(room).toMatchObject({ taskId: f.body.data.newTaskId, reason: 'Failed inspection', redoNote: 'Streaks on the mirror' })
  })
})

describe('inspection queue and the assign picker', () => {
  it('Final Inspection holders see the cleaned rooms of their site; a task they may not inspect is listed with reason, owner and next action', async () => {
    const s = await staffed()
    await act(assign, s.cookies.rec, s.v1.taskId, { housekeeperStaffId: s.hk.staffId })
    await act(clean, s.cookies.hk, s.v1.taskId, { checklist: { ...FULL, damage: true }, notes: 'Wardrobe door off its hinge' })
    const list = (await get(queue, s.cookies.insp)).body.data as any[]
    expect(list.map(i => i.taskId)).toEqual([s.v1.taskId])
    expect(list[0]).toMatchObject({ bedCode: expect.any(String), issue: true, notes: 'Wardrobe door off its hinge', blocked: null })
    expect(list[0].lines.find((l: any) => l.id === 'damage')).toMatchObject({ done: true })
    // An inspector who lives in the room sees it, blocked.
    const resident = await inspector(s.siteId)
    await mkStay({ bedId: s.bedIds[3], staffId: resident.staffId, from: day(-2), to: null })
    const mineList = (await get(queue, await resident.cookie())).body.data as any[]
    expect(mineList[0].blocked).toMatchObject({ reason: expect.stringMatching(/live in room/), owner: expect.any(String), next: expect.any(String) })
    // Another site's holder sees nothing of it.
    const other = await scene({ beds: 1 })
    expect((await get(queue, await other.insp.cookie())).body.data).toEqual([])
  })

  it('the picker lists people with an active Housekeeping grant only, and marks those who live in the room', async () => {
    const s = await staffed()
    const noGrant = await housekeeper({ grant: false })
    const neighbour = await housekeeper()
    await mkStay({ bedId: s.bedIds[3], staffId: neighbour.staffId, from: day(-2), to: null })
    const plain = (await get(housekeepers, s.cookies.rec)).body.data as any[]
    expect(plain.map(h => h.staffId)).toEqual(expect.arrayContaining([s.hk.staffId, neighbour.staffId]))
    expect(plain.map(h => h.staffId)).not.toContain(noGrant.staffId)
    const forTask = (await get(housekeepers, s.cookies.rec, `?taskId=${s.v1.taskId}`)).body.data as any[]
    expect(forTask.find(h => h.staffId === neighbour.staffId).blocked).toBe('Lives in this room')
    expect(forTask.find(h => h.staffId === s.hk.staffId).blocked).toBeNull()
    const other = await scene({ beds: 1 })
    expect((await get(housekeepers, await other.rec.cookie(), `?taskId=${s.v1.taskId}`)).status).toBe(404)
  })
})

describe('the routes enforce the commands', () => {
  it('fail needs a note (422 with the field), pass and fail refuse a housekeeper; assigning a person without the capability is 422', async () => {
    const s = await staffed()
    await act(assign, s.cookies.rec, s.v1.taskId, { housekeeperStaffId: s.hk.staffId })
    await act(clean, s.cookies.hk, s.v1.taskId, { checklist: FULL })
    const noNote = await act(failRoute, s.cookies.insp, s.v1.taskId, {})
    expect(noNote.status).toBe(422)
    expect(noNote.body.fields).toHaveProperty('note')
    expect((await act(failRoute, s.cookies.hk, s.v1.taskId, { note: 'nope nope' })).status).toBe(403)
    expect((await act(pass, s.cookies.hk, s.v1.taskId, {})).status).toBe(403)
    const stranger = await housekeeper({ grant: false })
    const bad = await act(assign, s.cookies.rec, s.v2.taskId, { housekeeperStaffId: stranger.staffId })
    expect(bad.status).toBe(422)
    expect(bad.body.owner).toBeTruthy()
    expect(bad.body.next).toBeTruthy()
    expect((await act(assign, s.cookies.rec, 'not-a-uuid', { housekeeperStaffId: stranger.staffId })).status).toBe(404)
  })
})

describe('evidence photos on a task', () => {
  const b64 = PNG_BYTES.toString('base64')
  const up = (cookie: string, taskId: string) => call(upload, { method: 'POST', cookie, body: { entityType: 'cleaning_task', entityId: taskId, filename: 'photo.png', dataBase64: b64 } })

  async function cleanedWithPhotos(s: Scene & { cookies: Record<string, string>; v1: { taskId: string } }) {
    await act(assign, s.cookies.rec, s.v1.taskId, { housekeeperStaffId: s.hk.staffId })
    const photo = await up(s.cookies.hk, s.v1.taskId)
    expect(photo.status, JSON.stringify(photo.body)).toBe(200)
    const r = await act(clean, s.cookies.hk, s.v1.taskId, { checklist: { ...FULL, damage: true }, notes: 'Cracked mirror', attachmentIds: [photo.body.data.id] })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    return photo.body.data.id as string
  }

  it('the assigned housekeeper attaches a photo of damage; the inspector, Reception and the Auditor see it; the Manager, another housekeeper and a resident do not', async () => {
    const s = await staffed()
    const id = await cleanedWithPhotos(s)
    expect((await admin().query(`SELECT checklist FROM cleaning_task WHERE id = $1`, [s.v1.taskId])).rows[0].checklist.attachmentIds).toEqual([id])
    for (const cookie of [s.cookies.insp, s.cookies.rec, s.cookies.sa, await (await staffAt('Aud', s.siteId)).cookie(), await (await staffAt('MC', s.siteId)).cookie()]) {
      const l = await call(listFiles, { cookie, path: `/api/v1/attachments?entityType=cleaning_task&entityId=${s.v1.taskId}` })
      expect(l.body.data, 'can see').toHaveLength(1)
    }
    for (const cookie of [await (await staffAt('Mgr', s.siteId)).cookie(), await (await housekeeper()).cookie(), await (await staffAt('Res', null)).cookie(), await (await inspector((await scene({ beds: 1 })).siteId)).cookie()]) {
      const l = await call(listFiles, { cookie, path: `/api/v1/attachments?entityType=cleaning_task&entityId=${s.v1.taskId}` })
      expect(l.body.data, 'cannot see').toEqual([])
      expect((await up(cookie, s.v1.taskId)).status).toBe(404)
    }
  })

  it('a failed inspection can carry photos, and only photos already attached to THAT task', async () => {
    const s = await staffed()
    await act(assign, s.cookies.rec, s.v1.taskId, { housekeeperStaffId: s.hk.staffId })
    await act(assign, s.cookies.rec, s.v2.taskId, { housekeeperStaffId: s.hk.staffId })
    await act(clean, s.cookies.hk, s.v1.taskId, { checklist: FULL })
    await act(clean, s.cookies.hk, s.v2.taskId, { checklist: FULL })
    const mine1 = await up(s.cookies.insp, s.v1.taskId)
    const mine2 = await up(s.cookies.insp, s.v2.taskId)
    expect(mine1.status).toBe(200)
    const wrong = await act(failRoute, s.cookies.insp, s.v1.taskId, { note: 'Mould behind the door', attachmentIds: [mine2.body.data.id] })
    expect(wrong.status).toBe(422)
    expect((await admin().query(`SELECT status FROM cleaning_task WHERE id = $1`, [s.v1.taskId])).rows[0].status).toBe('cleaned')
    const ok = await act(failRoute, s.cookies.insp, s.v1.taskId, { note: 'Mould behind the door', attachmentIds: [mine1.body.data.id] })
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    const audit = (await admin().query(`SELECT after FROM audit_event WHERE action = 'readiness.inspection.failed' AND entity_id = $1`, [s.v1.taskId])).rows[0]
    expect(audit.after.attachments).toBe(1)
    // The housekeeper of the redo can still see the evidence (it hangs on the task they cleaned).
    expect(((await call(listFiles, { cookie: s.cookies.hk, path: `/api/v1/attachments?entityType=cleaning_task&entityId=${s.v1.taskId}` })).body.data)).toHaveLength(1)
  })
})
