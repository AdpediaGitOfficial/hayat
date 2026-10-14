/**
 * AT-035 hardening pass: the key-control rules, with the shipped defaults (no proposed policy is switched on here; those are in
 * proposals.test.ts). Written first, then the code was fixed where a test failed (the database guard of migration 0150).
 *
 *   - only an `issued` item can be returned; a lost or damaged one never is, through the API AND in the database, by every path
 *   - exactly one holder at a time; two simultaneous issues or returns of one item: one wins, the loser gets a conflict with a next action
 *   - replacement retires the old key, links `replaced_by`, and issues the new key to the same holder only if still eligible
 *   - retire clears the holder and keeps who held it in the event
 *   - archive of a bed, room or building is refused while an item is issued, lost or damaged
 *   - nobody moves their own key or asset (D-26) on any movement
 *   - scope: Reception of site A cannot see or move a site B item; a resident sees only theirs; Auditor and Manager are read-only
 *   - the event log is append-only for the application role and for the owner
 */
import { afterAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { inject } from 'vitest'
import { admin, closeAll, uniq } from '../harness'
import { as, auditsOf, events, itemRow, mkItem, mkProperty, mkStayFor, person, resident, stayStatus, checkOutDirectly, world } from './helpers'
import { bulkCreateItems } from '@/server/commands/keys/registry'
import { foundItem, issueItem, markDamaged, markLost, replaceItem, retireItem, returnItem } from '@/server/commands/keys/movements'
import { archiveBuilding } from '@/server/commands/property/archiveBuilding'
import { archiveRoom } from '@/server/commands/property/archiveRoom'
import { archiveBed } from '@/server/commands/property/archiveBed'
import { markLeft } from '@/server/commands/exit/markLeft'
import { completeItem } from '@/server/commands/exit/items'
import { previewBulkExit, confirmBulkExit } from '@/server/commands/exit/bulk'
import { canUseKeys, getItemDetail, listItems } from '@/server/queries/keys/items'
import { PASSWORD } from '../harness'
import { registerStayCloser } from '@/server/stays-close'

afterAll(closeAll)
registerStayCloser('keys-control-test', async () => true)

const appPool = new Pool({ connectionString: inject('appDbUrl'), max: 2 })
afterAll(async () => { await appPool.end() })

const issue = (by: { rc: Parameters<typeof issueItem>[0] }, itemId: string, staffId: string) => issueItem(by.rc, { itemId, staffId, dueBack: null, note: null })
const sqlCode = (pool: Pool, text: string, params: unknown[] = []) => pool.query(text, params).then(() => null, (e: { code?: string }) => e.code ?? 'error')

async function scene(o: { beds?: number } = {}) {
  const w = await world({ beds: o.beds ?? 3 })
  const res = await resident(w.bedIds[0])
  const roomKey = await mkItem({ siteId: w.siteId, roomId: w.roomId, code: uniq('RK') })
  return { ...w, res, roomKey }
}

describe('AT-035: only an issued item can be returned (API)', () => {
  it('an item in the cabinet, a retired one: a conflict that says there is nothing to return', async () => {
    const s = await scene()
    const r1 = await returnItem(s.rec.rc, { itemId: s.roomKey, note: null })
    expect(r1).toMatchObject({ ok: false, code: 'conflict', owner: 'Reception', next: 'Nothing to return', detail: { reason: 'already_in_cabinet' } })
    const retired = await mkItem({ siteId: s.siteId, roomId: s.roomId, status: 'retired' })
    expect(await returnItem(s.rec.rc, { itemId: retired, note: null })).toMatchObject({ ok: false, code: 'conflict', detail: { reason: 'not_issued', status: 'retired' } })
    expect((await events(s.roomKey)).filter(e => e.kind === 'returned')).toHaveLength(0)
  })

  it('a lost or damaged item is never returned: refused with owner and next action, whoever asks and however it is asked', async () => {
    const s = await scene()
    for (const status of ['lost', 'damaged'] as const) {
      const id = await mkItem({ siteId: s.siteId, roomId: s.roomId, holderStaffId: s.res.staffId, status })
      for (const by of [s.rec, s.aa]) {
        for (const onBehalf of [undefined, true, false]) {
          const r = await returnItem(by.rc, { itemId: id, note: null, onBehalf })
          expect(r, `${status} ${onBehalf}`).toMatchObject({ ok: false, code: 'conflict', detail: { reason: `${status}_not_returnable` } })
          if (!r.ok) { expect(r.owner).toBe('Accommodation Admin'); expect(r.next).toBeTruthy() }
        }
      }
      expect(await itemRow(id)).toMatchObject({ status, holder_staff_id: s.res.staffId })
      expect((await events(id)).filter(e => e.kind === 'returned')).toHaveLength(0)
    }
  })
})

describe('AT-035: lost or damaged is never returned (database)', () => {
  it('the database refuses to move a lost item to the cabinet or its holder except as "found"; a damaged one never; a retired one stays retired', async () => {
    const s = await scene()
    for (const pool of [admin(), appPool] as Pool[]) {
      const lost = await mkItem({ siteId: s.siteId, roomId: s.roomId, holderStaffId: s.res.staffId, status: 'lost' })
      expect(await sqlCode(pool, `UPDATE handover_item SET status = 'in_cabinet', holder_staff_id = NULL WHERE id = $1`, [lost])).toBe('GH001')
      expect(await sqlCode(pool, `UPDATE handover_item SET status = 'issued' WHERE id = $1`, [lost])).toBe('GH001')
      const damaged = await mkItem({ siteId: s.siteId, roomId: s.roomId, holderStaffId: s.res.staffId, status: 'damaged' })
      expect(await sqlCode(pool, `UPDATE handover_item SET status = 'in_cabinet', holder_staff_id = NULL WHERE id = $1`, [damaged])).toBe('GH001')
      expect(await sqlCode(pool, `UPDATE handover_item SET status = 'issued' WHERE id = $1`, [damaged])).toBe('GH001')
      const retired = await mkItem({ siteId: s.siteId, roomId: s.roomId, status: 'retired' })
      expect(await sqlCode(pool, `UPDATE handover_item SET status = 'in_cabinet' WHERE id = $1`, [retired])).toBe('GH001')
      for (const id of [lost, damaged]) expect(await itemRow(id)).toMatchObject({ holder_staff_id: s.res.staffId })
      expect(await itemRow(lost)).toMatchObject({ status: 'lost' })
      expect(await itemRow(damaged)).toMatchObject({ status: 'damaged' })
      expect(await itemRow(retired)).toMatchObject({ status: 'retired' })
      // what stays possible: retiring, and marking lost from issued
      expect(await sqlCode(pool, `UPDATE handover_item SET status = 'retired', holder_staff_id = NULL WHERE id = $1`, [damaged])).toBeNull()
    }
  })

  it('"found" is the one way back, and the command does it', async () => {
    const s = await scene()
    const id = await mkItem({ siteId: s.siteId, roomId: s.roomId, holderStaffId: s.res.staffId, status: 'lost' })
    expect((await foundItem(s.rec.rc, { itemId: id, to: 'holder', note: 'Found under the bed' })).ok).toBe(true)
    expect(await itemRow(id)).toMatchObject({ status: 'issued', holder_staff_id: s.res.staffId })
    expect((await markLost(s.rec.rc, { itemId: id, note: 'Gone again' })).ok).toBe(true)
    expect((await foundItem(s.rec.rc, { itemId: id, to: 'cabinet', note: null })).ok).toBe(true)
    expect(await itemRow(id)).toMatchObject({ status: 'in_cabinet', holder_staff_id: null })
    // the permission does not leak out of the command: a plain update straight afterwards is refused again
    const again = await mkItem({ siteId: s.siteId, roomId: s.roomId, holderStaffId: s.res.staffId, status: 'lost' })
    expect(await sqlCode(admin(), `UPDATE handover_item SET status = 'in_cabinet', holder_staff_id = NULL WHERE id = $1`, [again])).toBe('GH001')
  })

  it('one holder at a time: an issued item cannot change hands in one step', async () => {
    const s = await scene()
    const other = await resident(s.bedIds[1])
    const id = await mkItem({ siteId: s.siteId, roomId: s.roomId, holderStaffId: s.res.staffId })
    expect(await sqlCode(admin(), `UPDATE handover_item SET holder_staff_id = $2 WHERE id = $1`, [id, other.staffId])).toBe('GH001')
    expect(await sqlCode(appPool, `UPDATE handover_item SET holder_staff_id = $2 WHERE id = $1`, [id, other.staffId])).toBe('GH001')
    expect(await itemRow(id)).toMatchObject({ holder_staff_id: s.res.staffId })
  })
})

describe('AT-035: every path leaves a lost or damaged item un-returned (replace, clearance, bulk)', () => {
  it('replace: the old key is retired and replaced, never returned', async () => {
    const s = await scene()
    for (const status of ['lost', 'damaged'] as const) {
      const id = await mkItem({ siteId: s.siteId, roomId: s.roomId, holderStaffId: s.res.staffId, status, code: uniq('OLD') })
      const r = await replaceItem(s.aa.rc, { itemId: id, newCode: uniq('NEW'), note: null })
      expect(r.ok, JSON.stringify(r)).toBe(true)
      expect(await itemRow(id)).toMatchObject({ status: 'retired', holder_staff_id: null })
      expect((await events(id)).map(e => e.kind)).toEqual(['replaced'])
    }
  })

  it('clearance: a lost key on a former employee\'s case cannot be ticked off as returned; the Policy Approver\'s waiver retires it (history kept)', async () => {
    const s = await scene()
    const sa = await person('SA')
    const lostKey = await mkItem({ siteId: s.siteId, roomId: s.roomId, holderStaffId: s.res.staffId, status: 'lost', code: uniq('LK') })
    const left = await markLeft(sa.rc, { staffId: s.res.staffId, effectiveDate: '2026-10-14', reason: 'Resigned', confirmPassword: PASSWORD })
    expect(left.ok, JSON.stringify(left)).toBe(true)
    if (!left.ok) return
    const item = (await admin().query<{ id: string }>(`SELECT id FROM clearance_item WHERE case_id = $1 AND handover_item_id = $2`, [left.data.caseId, lostKey])).rows[0]
    expect(await completeItem(s.rec.rc, { itemId: item.id, note: 'They gave it back' })).toMatchObject({ ok: false, code: 'conflict', detail: { reason: 'lost_or_damaged' } })
    expect(await itemRow(lostKey)).toMatchObject({ status: 'lost', holder_staff_id: s.res.staffId })
    expect((await events(lostKey)).filter(e => e.kind === 'returned')).toHaveLength(0)
  })

  it('bulk: bulk-created items are all new in the cabinet; a bulk exit leaves a lost key lost', async () => {
    const s = await scene()
    const made = await bulkCreateItems(s.aa.rc, { siteId: s.siteId, category: 'key', itemType: 'room_key', roomId: s.roomId, bedId: null, note: null, prefix: uniq('B') + '-', count: 3 })
    expect(made.ok && made.data.created).toBe(3)
    if (made.ok) for (const row of made.data.rows) { expect(await itemRow(row.id!)).toMatchObject({ status: 'in_cabinet', holder_staff_id: null }); expect(await events(row.id!)).toHaveLength(0) }

    const lostKey = await mkItem({ siteId: s.siteId, roomId: s.roomId, holderStaffId: s.res.staffId, status: 'lost' })
    const employeeId = (await admin().query<{ employee_id: string }>(`SELECT employee_id FROM staff_profile WHERE id = $1`, [s.res.staffId])).rows[0].employee_id
    const sa = await person('SA')
    const preview = await previewBulkExit(sa.rc, { employeeIds: [employeeId], effectiveDate: '2026-10-14', reason: 'Bulk resignation' })
    expect(preview.ok, JSON.stringify(preview)).toBe(true)
    if (!preview.ok) return
    const done = await confirmBulkExit(sa.rc, { batchId: preview.data.batchId, confirmPassword: PASSWORD })
    expect(done.ok, JSON.stringify(done)).toBe(true)
    expect(await itemRow(lostKey)).toMatchObject({ status: 'lost', holder_staff_id: s.res.staffId })
    expect((await events(lostKey)).filter(e => e.kind === 'returned')).toHaveLength(0)
  })
})

describe('AT-035: exactly one holder, and a loser that is told what to do', () => {
  it('two simultaneous issues of one key to different residents: one wins, the other gets a conflict with owner and next action', async () => {
    for (let round = 0; round < 4; round++) {
      const s = await scene()
      const second = await resident(s.bedIds[1])
      const [a, b] = await Promise.all([issue(s.rec, s.roomKey, s.res.staffId), issue(s.aa, s.roomKey, second.staffId)])
      expect([a.ok, b.ok].sort(), `round ${round}`).toEqual([false, true])
      const loser = a.ok ? b : a
      expect(loser).toMatchObject({ ok: false, code: 'conflict', detail: { reason: 'not_in_cabinet', status: 'issued' } })
      if (!loser.ok) { expect(loser.owner).toBe('Reception'); expect(loser.next).toMatch(/return/i) }
      const winnerStaff = a.ok ? s.res.staffId : second.staffId
      expect(await itemRow(s.roomKey)).toMatchObject({ status: 'issued', holder_staff_id: winnerStaff })
      expect((await events(s.roomKey)).filter(e => e.kind === 'issued')).toHaveLength(1)
    }
  })

  it('two simultaneous returns of one key: one wins, the other is told it is already in the cabinet', async () => {
    for (let round = 0; round < 4; round++) {
      const s = await scene()
      expect((await issue(s.rec, s.roomKey, s.res.staffId)).ok).toBe(true)
      const [a, b] = await Promise.all([returnItem(s.rec.rc, { itemId: s.roomKey, note: null }), returnItem(s.aa.rc, { itemId: s.roomKey, note: null })])
      expect([a.ok, b.ok].sort(), `round ${round}`).toEqual([false, true])
      const loser = a.ok ? b : a
      expect(loser).toMatchObject({ ok: false, code: 'conflict', detail: { reason: 'already_in_cabinet' }, next: 'Nothing to return' })
      expect((await events(s.roomKey)).filter(e => e.kind === 'returned')).toHaveLength(1)
      expect(await itemRow(s.roomKey)).toMatchObject({ status: 'in_cabinet', holder_staff_id: null })
    }
  })

  it('a return racing a lost report: both are serialised on the item; the result is one consistent state and one history', async () => {
    const s = await scene()
    expect((await issue(s.rec, s.roomKey, s.res.staffId)).ok).toBe(true)
    const [a, b] = await Promise.all([returnItem(s.rec.rc, { itemId: s.roomKey, note: null }), markLost(s.aa.rc, { itemId: s.roomKey, note: 'Lost at the pool' })])
    const row = await itemRow(s.roomKey)
    const kinds = (await events(s.roomKey)).map(e => e.kind)
    if (a.ok && b.ok) {
      // return first, then "lost" from the cabinet (allowed: a cabinet key can be reported missing)
      expect(kinds).toEqual(['issued', 'returned', 'lost'])
      expect(row.status).toBe('lost')
    } else {
      expect([a.ok, b.ok]).toContain(true)
      expect(kinds).toHaveLength(2)
    }
    // whichever order, a lost item is never "returned" afterwards
    if (row.status === 'lost') expect(kinds.lastIndexOf('returned')).toBeLessThan(kinds.indexOf('lost'))
  })
})

describe('AT-035: replacement and retirement', () => {
  it('replacing a lost key retires the old one, links replaced_by and issues the new one to the SAME holder when still eligible', async () => {
    const s = await scene()
    const lostKey = await mkItem({ siteId: s.siteId, bedId: s.bedIds[0], holderStaffId: s.res.staffId, status: 'lost', code: uniq('OLD') })
    const code = uniq('NEW')
    const r = await replaceItem(s.aa.rc, { itemId: lostKey, newCode: code, note: 'Cut a new one' })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    if (!r.ok) return
    expect(r.data).toMatchObject({ newStatus: 'issued', holderStaffId: s.res.staffId })
    const old = await itemRow(lostKey)
    expect(old).toMatchObject({ status: 'retired', holder_staff_id: null, replaced_by: r.data.newId })
    expect(await itemRow(r.data.newId)).toMatchObject({ status: 'issued', holder_staff_id: s.res.staffId, code })
    expect((await events(lostKey)).at(-1)).toMatchObject({ kind: 'replaced', staff_id: s.res.staffId })        // who held the old one is kept
    expect(await events(r.data.newId)).toEqual([expect.objectContaining({ kind: 'issued', staff_id: s.res.staffId, note: expect.stringContaining('Replacement for') })])
    const a = await auditsOf(lostKey)
    expect(a.at(-1)).toMatchObject({ action: 'keys.item.replaced' })
    expect(a.at(-1)?.after).toMatchObject({ status: 'retired', replacedByCode: code, reissuedTo: s.res.staffId, formerHolderStaffId: s.res.staffId })
  })

  it('a holder who is no longer eligible (left, or no stay in that bed any more) gets no new key: it goes to the cabinet', async () => {
    const s = await scene()
    const gone = await resident(s.bedIds[1])
    await admin().query(`UPDATE staff_profile SET employment_status = 'left', left_at = now() WHERE id = $1`, [gone.staffId])
    const lostGone = await mkItem({ siteId: s.siteId, bedId: s.bedIds[1], holderStaffId: gone.staffId, status: 'lost' })
    const r1 = await replaceItem(s.aa.rc, { itemId: lostGone, newCode: uniq('N'), note: null })
    expect(r1.ok && r1.data).toMatchObject({ newStatus: 'in_cabinet', holderStaffId: null })

    const moved = await resident(s.bedIds[2])
    const lostMoved = await mkItem({ siteId: s.siteId, bedId: s.bedIds[2], holderStaffId: moved.staffId, status: 'damaged' })
    await admin().query(`UPDATE stay SET status = 'checked_out', checked_out_at = now() WHERE id = $1`, [moved.stayId])
    const r2 = await replaceItem(s.aa.rc, { itemId: lostMoved, newCode: uniq('N'), note: null })
    expect(r2.ok && r2.data).toMatchObject({ newStatus: 'in_cabinet', holderStaffId: null })
    expect(await itemRow(lostMoved)).toMatchObject({ status: 'retired', holder_staff_id: null })
  })

  it('only a lost or damaged item is replaced; a duplicate code leaves the old item exactly as it was (all or nothing)', async () => {
    const s = await scene()
    expect(await replaceItem(s.aa.rc, { itemId: s.roomKey, newCode: uniq('N'), note: null })).toMatchObject({ ok: false, code: 'conflict', detail: { reason: 'not_replaceable' } })
    const lostKey = await mkItem({ siteId: s.siteId, roomId: s.roomId, holderStaffId: s.res.staffId, status: 'lost' })
    const dup = await replaceItem(s.aa.rc, { itemId: lostKey, newCode: (await itemRow(s.roomKey)).code, note: null })
    expect(dup).toMatchObject({ ok: false, code: 'conflict', fields: { newCode: expect.any(String) } })
    expect(await itemRow(lostKey)).toMatchObject({ status: 'lost', holder_staff_id: s.res.staffId, replaced_by: null })
    expect((await events(lostKey)).filter(e => e.kind === 'replaced')).toHaveLength(0)
    // Reception cannot replace or retire: only the Accommodation Admin and Super Admin (keys.manage)
    expect(await replaceItem(s.rec.rc, { itemId: lostKey, newCode: uniq('N'), note: null })).toMatchObject({ ok: false, code: 'forbidden' })
    expect(await retireItem(s.rec.rc, { itemId: lostKey, reason: 'Never coming back' })).toMatchObject({ ok: false, code: 'forbidden' })
  })

  it('retire clears the holder and the event keeps who held it; an issued item must be returned or reported first', async () => {
    const s = await scene()
    const lostKey = await mkItem({ siteId: s.siteId, roomId: s.roomId, holderStaffId: s.res.staffId, status: 'lost' })
    expect((await retireItem(s.aa.rc, { itemId: lostKey, reason: 'Will not be found' })).ok).toBe(true)
    expect(await itemRow(lostKey)).toMatchObject({ status: 'retired', holder_staff_id: null })
    expect((await events(lostKey)).at(-1)).toMatchObject({ kind: 'retired', staff_id: s.res.staffId, note: 'Will not be found' })
    expect((await auditsOf(lostKey)).at(-1)?.after).toMatchObject({ formerHolderStaffId: s.res.staffId, holderStaffId: null })
    const held = await mkItem({ siteId: s.siteId, roomId: s.roomId, holderStaffId: s.res.staffId })
    expect(await retireItem(s.aa.rc, { itemId: held, reason: 'Worn' })).toMatchObject({ ok: false, code: 'conflict', detail: { reason: 'issued' } })
    expect(await itemRow(held)).toMatchObject({ status: 'issued' })
    // and the person no longer holds anything outstanding for this item
    const open = await admin().query(`SELECT 1 FROM handover_item WHERE holder_staff_id = $1 AND status IN ('issued','lost','damaged') AND id = $2`, [s.res.staffId, lostKey])
    expect(open.rowCount).toBe(0)
  })

  it('retiring a lost key is the last thing a checked-out, cleared stay was waiting for: the stay closes (D-64)', async () => {
    const s = await scene()
    const lostKey = await mkItem({ siteId: s.siteId, roomId: s.roomId, holderStaffId: s.res.staffId, status: 'lost' })
    await checkOutDirectly(s.res.stayId, '2026-10-14T09:00:00Z')
    expect((await stayStatus(s.res.stayId)).status).toBe('checked_out')
    const r = await retireItem(s.aa.rc, { itemId: lostKey, reason: 'Written off' })
    expect(r.ok && r.data.closedStays).toEqual([s.res.stayId])
    expect((await stayStatus(s.res.stayId)).status).toBe('closed')
  })
})

describe('AT-035: archive is blocked while an item is issued, lost or damaged', () => {
  it('a bed, a room and a building each refuse, naming the item; a retired or returned item no longer blocks', async () => {
    for (const status of ['issued', 'lost', 'damaged'] as const) {
      const w = await world({ beds: 2 })
      const sa = await person('SA')
      const holder = await resident(w.bedIds[1])
      const bedKey = await mkItem({ siteId: w.siteId, bedId: w.bedIds[0], holderStaffId: holder.staffId, status })
      const bed = await archiveBed(w.aa.rc, { id: w.bedIds[0], reason: 'Renovation' })
      expect(bed.ok, `bed ${status}`).toBe(false)
      if (!bed.ok) expect(JSON.stringify(bed.detail)).toContain('outstanding_item')
      const room = await archiveRoom(w.aa.rc, { id: w.roomId, reason: 'Renovation', cascade: true } as never)
      expect(room.ok, `room ${status}`).toBe(false)
      if (!room.ok) expect(JSON.stringify(room.detail)).toContain('outstanding_item')
      const building = await archiveBuilding(sa.rc, { id: w.buildingId!, reason: 'Renovation', cascade: true })
      expect(building.ok, `building ${status}`).toBe(false)
      if (!building.ok) { expect(JSON.stringify(building.detail)).toContain('outstanding_item'); expect(building.owner || building.next).toBeTruthy() }
      expect((await admin().query(`SELECT archived_at FROM building WHERE id = $1`, [w.buildingId])).rows[0].archived_at).toBeNull()
      // resolve it: the key no longer blocks the building
      const res = status === 'issued' ? await returnItem(w.rec.rc, { itemId: bedKey, note: null }) : await retireItem(w.aa.rc, { itemId: bedKey, reason: 'Written off' })
      expect(res.ok, status).toBe(true)
      const after = await archiveBuilding(sa.rc, { id: w.buildingId!, reason: 'Renovation', cascade: true })
      expect(JSON.stringify(after.ok ? '' : after.detail)).not.toContain('outstanding_item')
    }
  })
})

describe('AT-035: nobody moves their own key or asset (D-26)', () => {
  it('every movement is refused for the person it concerns, and nothing changes', async () => {
    const w = await world()
    // a Reception officer who is also staying here, and an Accommodation Admin who is
    const rec = await person('Rec', { siteIds: [w.siteId] })
    const aa = await person('AA', { siteIds: [w.siteId] })
    await mkStayFor({ staffId: rec.staffId, bedId: w.bedIds[1] })
    await mkStayFor({ staffId: aa.staffId, bedId: w.bedIds[2] })
    const sod = (r: { ok: boolean; code?: string }) => expect(r).toMatchObject({ ok: false, code: 'separation_of_duties' })

    const cabinetKey = await mkItem({ siteId: w.siteId, bedId: w.bedIds[1] })
    sod(await issue(rec, cabinetKey, rec.staffId))
    const heldByRec = await mkItem({ siteId: w.siteId, bedId: w.bedIds[1], holderStaffId: rec.staffId })
    sod(await returnItem(rec.rc, { itemId: heldByRec, note: null }))
    sod(await markLost(rec.rc, { itemId: heldByRec, note: 'Mine, lost' }))
    sod(await markDamaged(rec.rc, { itemId: heldByRec, note: 'Mine, bent' }))
    const lostByRec = await mkItem({ siteId: w.siteId, bedId: w.bedIds[1], holderStaffId: rec.staffId, status: 'lost' })
    sod(await foundItem(rec.rc, { itemId: lostByRec, to: 'holder', note: null }))
    const lostByAa = await mkItem({ siteId: w.siteId, bedId: w.bedIds[2], holderStaffId: aa.staffId, status: 'lost' })
    sod(await retireItem(aa.rc, { itemId: lostByAa, reason: 'My own key, never mind' }))
    sod(await replaceItem(aa.rc, { itemId: lostByAa, newCode: uniq('N'), note: null }))
    sod(await foundItem(aa.rc, { itemId: lostByAa, to: 'cabinet', note: null }))
    expect(await itemRow(cabinetKey)).toMatchObject({ status: 'in_cabinet' })
    expect(await itemRow(heldByRec)).toMatchObject({ status: 'issued', holder_staff_id: rec.staffId })
    expect(await itemRow(lostByRec)).toMatchObject({ status: 'lost' })
    expect(await itemRow(lostByAa)).toMatchObject({ status: 'lost', holder_staff_id: aa.staffId })
    for (const id of [cabinetKey, heldByRec, lostByRec, lostByAa]) expect(await events(id)).toHaveLength(0)
    // a colleague can do all of it for them
    expect((await returnItem(w.rec.rc, { itemId: heldByRec, note: null })).ok).toBe(true)
  })
})

describe('AT-035: scope and read-only roles', () => {
  it('Reception of site A cannot see or move a site B item: it reads as not found, for every movement', async () => {
    const a = await world({ beds: 2 }), b = await world({ beds: 2 })
    const holderB = await resident(b.bedIds[0])
    const inB = await mkItem({ siteId: b.siteId, bedId: b.bedIds[0] })
    const heldB = await mkItem({ siteId: b.siteId, bedId: b.bedIds[0], holderStaffId: holderB.staffId })
    const lostB = await mkItem({ siteId: b.siteId, bedId: b.bedIds[0], holderStaffId: holderB.staffId, status: 'lost' })
    const nf = (r: { ok: boolean; code?: string }) => expect(r).toMatchObject({ ok: false, code: 'not_found' })
    nf(await issue(a.rec, inB, holderB.staffId))
    nf(await returnItem(a.rec.rc, { itemId: heldB, note: null }))
    nf(await markLost(a.rec.rc, { itemId: heldB, note: 'x' }))
    nf(await markDamaged(a.rec.rc, { itemId: heldB, note: 'x' }))
    nf(await foundItem(a.rec.rc, { itemId: lostB, to: 'holder', note: null }))
    nf(await retireItem(a.aa.rc, { itemId: lostB, reason: 'x y z' }))
    nf(await replaceItem(a.aa.rc, { itemId: lostB, newCode: uniq('N'), note: null }))
    expect((await listItems(a.rec.rc.actor, {})).rows.map(r => r.id)).not.toEqual(expect.arrayContaining([inB]))
    expect(await getItemDetail(a.rec.rc.actor, inB)).toBeUndefined()
    expect(await itemRow(heldB)).toMatchObject({ status: 'issued' })
  })

  it('a resident sees only the items they hold, never another\'s or one in the cabinet', async () => {
    const w = await world({ beds: 2 })
    const mine = await resident(w.bedIds[0]), theirs = await resident(w.bedIds[1])
    const myItem = await mkItem({ siteId: w.siteId, bedId: w.bedIds[0], holderStaffId: mine.staffId })
    const theirItem = await mkItem({ siteId: w.siteId, bedId: w.bedIds[1], holderStaffId: theirs.staffId })
    const cabinet = await mkItem({ siteId: w.siteId, bedId: w.bedIds[0] })
    expect((await listItems(mine.rc.actor, {})).rows.map(r => r.id)).toEqual([myItem])
    expect(await getItemDetail(mine.rc.actor, theirItem)).toBeUndefined()
    expect(await getItemDetail(mine.rc.actor, cabinet)).toBeUndefined()
    expect(await getItemDetail(mine.rc.actor, myItem)).toBeDefined()
  })

  it('the Auditor reads and cannot move anything; the Read-only Manager has no key access at all', async () => {
    const w = await world({ beds: 2 })
    const holder = await resident(w.bedIds[0])
    const held = await mkItem({ siteId: w.siteId, bedId: w.bedIds[0], holderStaffId: holder.staffId })
    const lostOne = await mkItem({ siteId: w.siteId, bedId: w.bedIds[0], holderStaffId: holder.staffId, status: 'lost' })
    const cabinet = await mkItem({ siteId: w.siteId, bedId: w.bedIds[0] })
    const aud = await person('Aud', { siteIds: [w.siteId] })
    const mgr = await person('Mgr', { siteIds: [w.siteId] })
    expect((await listItems(aud.rc.actor, {})).rows.map(r => r.id)).toEqual(expect.arrayContaining([held, lostOne, cabinet]))
    expect(await getItemDetail(aud.rc.actor, held)).toBeDefined()
    expect(canUseKeys(mgr.rc.actor)).toBe(false)
    expect((await listItems(mgr.rc.actor, {})).rows).toHaveLength(0)
    expect(await getItemDetail(mgr.rc.actor, held)).toBeUndefined()
    for (const who of [aud, mgr]) {
      const ff = (r: { ok: boolean; code?: string }) => expect(r).toMatchObject({ ok: false, code: 'forbidden' })
      ff(await issue(who, cabinet, holder.staffId))
      ff(await returnItem(who.rc, { itemId: held, note: null }))
      ff(await markLost(who.rc, { itemId: held, note: 'x y z' }))
      ff(await markDamaged(who.rc, { itemId: held, note: 'x y z' }))
      ff(await foundItem(who.rc, { itemId: lostOne, to: 'holder', note: null }))
      ff(await retireItem(who.rc, { itemId: lostOne, reason: 'x y z' }))
      ff(await replaceItem(who.rc, { itemId: lostOne, newCode: uniq('N'), note: null }))
    }
    expect(await itemRow(held)).toMatchObject({ status: 'issued' })
    // the same person acting as Reception is allowed: it is the role that decides
    expect((await returnItem(as(aud, 'Rec', { siteIds: [w.siteId] }).rc, { itemId: held, note: null })).ok).toBe(true)
  })
})

describe('AT-035: every movement has an event row AND an audit row, and the event log is append-only', () => {
  it('each movement writes exactly one event and one audit row for the item', async () => {
    const s = await scene()
    const res = s.res
    const run = async (name: string, fn: () => Promise<{ ok: boolean }>, eventKind: string, auditAction: string, id: string) => {
      const e0 = (await events(id)).length, a0 = (await auditsOf(id)).length
      const r = await fn()
      expect(r.ok, name).toBe(true)
      expect((await events(id)).length - e0, `${name} events`).toBe(1)
      expect((await events(id)).at(-1)!.kind, name).toBe(eventKind)
      const a = await auditsOf(id)
      expect(a.length - a0, `${name} audit rows`).toBe(1)
      expect(a.at(-1)!.action, name).toBe(auditAction)
      expect(a.at(-1)).toMatchObject({ actor_role: expect.any(String), site_id: s.siteId })
      expect(a.at(-1)!.before ?? a.at(-1)!.after).toBeTruthy()
    }
    const id = s.roomKey
    await run('issue', () => issue(s.rec, id, res.staffId), 'issued', 'keys.item.issued', id)
    await run('return', () => returnItem(s.rec.rc, { itemId: id, note: null }), 'returned', 'keys.item.returned', id)
    await run('lost', () => markLost(s.rec.rc, { itemId: id, note: 'Missing from the cabinet' }), 'lost', 'keys.item.lost', id)
    await run('found', () => foundItem(s.rec.rc, { itemId: id, to: 'cabinet', note: null }), 'found', 'keys.item.found', id)
    await run('damaged', () => markDamaged(s.rec.rc, { itemId: id, note: 'Bent in the cabinet' }), 'damaged', 'keys.item.damaged', id)
    await run('retire', () => retireItem(s.aa.rc, { itemId: id, reason: 'Written off' }), 'retired', 'keys.item.retired', id)
    const other = await mkItem({ siteId: s.siteId, roomId: s.roomId, holderStaffId: res.staffId, status: 'lost' })
    await run('replace', () => replaceItem(s.aa.rc, { itemId: other, newCode: uniq('N'), note: null }), 'replaced', 'keys.item.replaced', other)
  })

  it('the event log refuses UPDATE, DELETE and TRUNCATE: the application role is not granted them, the owner is stopped by a trigger', async () => {
    const s = await scene()
    expect((await issue(s.rec, s.roomKey, s.res.staffId)).ok).toBe(true)
    const before = JSON.stringify(await events(s.roomKey))
    expect(await sqlCode(appPool, `UPDATE handover_event SET note = 'edited' WHERE item_id = $1`, [s.roomKey])).toBe('42501')
    expect(await sqlCode(appPool, `DELETE FROM handover_event WHERE item_id = $1`, [s.roomKey])).toBe('42501')
    expect(await sqlCode(appPool, `TRUNCATE handover_event`)).toBe('42501')
    expect(await sqlCode(admin(), `UPDATE handover_event SET note = 'edited' WHERE item_id = $1`, [s.roomKey])).toBe('GH002')
    expect(await sqlCode(admin(), `DELETE FROM handover_event WHERE item_id = $1`, [s.roomKey])).toBe('GH002')
    expect(await sqlCode(admin(), `TRUNCATE handover_event`)).toBe('GH002')
    expect(JSON.stringify(await events(s.roomKey))).toBe(before)
    // and the audit log likewise
    expect(await sqlCode(appPool, `UPDATE audit_event SET reason = 'edited' WHERE entity_id = $1`, [s.roomKey])).toBe('42501')
    expect(await sqlCode(admin(), `DELETE FROM audit_event WHERE entity_id = $1`, [s.roomKey])).toBe('GH002')
  })
})

void mkProperty
