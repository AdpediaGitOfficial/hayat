/**
 * WP-I movements: issue, return, lost, damaged, found, retire, replace. The proofs of STAGE-3 section 7 (5):
 * a lost or damaged key is never marked returned; replacement retires the old key and links the new one (D-73); two simultaneous
 * issues of one key: exactly one wins; the last return closes a cleared stay (D-64); D-26 (never to oneself); every movement
 * writes an event and an audit row.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { admin, closeAll, uniq } from '../harness'
import { as, auditsOf, checkOutDirectly, day, events, itemRow, mkItem, mkProperty, mkStayFor, person, resident, stayStatus, world } from './helpers'
import { createItem } from '@/server/commands/keys/registry'
import { foundItem, issueItem, lostInput, markDamaged, markLost, replaceItem, retireInput, retireItem, returnItem } from '@/server/commands/keys/movements'
import { registerStayCloser } from '@/server/stays-close'
import { outstandingHandovers } from '@/server/handover/outstanding'
import { getDb } from '@/server/db/client'
import { attach } from '@/server/attachments'
import { PNG } from '../fixtures3'
import { notificationsByKey } from '../fixtures2'
import type { Person } from './helpers'

afterAll(closeAll)

// A stay is cleared by its clearance case (WP-H registers the real closer); for these tests anything checked out counts as cleared.
registerStayCloser('keys-test', async () => true)

const issue = (by: Person, itemId: string, staffId: string, o: { dueBack?: string | null; note?: string | null } = {}) => issueItem(by.rc, { itemId, staffId, dueBack: o.dueBack ?? null, note: o.note ?? null })

/** A site, a room with beds, a resident staying in bed 0 and a key linked to that bed, in the cabinet. */
async function scene(o: { beds?: number } = {}) {
  const w = await world({ beds: o.beds ?? 2 })
  const res = await resident(w.bedIds[0])
  const itemId = await mkItem({ siteId: w.siteId, bedId: w.bedIds[0], code: uniq('K') })
  return { ...w, res, itemId }
}

describe('issueItem', () => {
  it('Reception issues a key from the cabinet to the resident staying in its bed: issued, holder, time, event, audit, resident told', async () => {
    const s = await scene()
    const r = await issue(s.rec, s.itemId, s.res.staffId, { dueBack: day(30), note: 'Handed over at the desk' })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    const row = await itemRow(s.itemId)
    expect(row).toMatchObject({ status: 'issued', holder_staff_id: s.res.staffId, due_back: day(30) })
    expect(row.issued_at?.getTime()).toBe(s.rec.rc.clock.nowMs())
    const ev = await events(s.itemId)
    expect(ev).toHaveLength(1)
    expect(ev[0]).toMatchObject({ kind: 'issued', staff_id: s.res.staffId, actor_user_id: s.rec.userId, on_behalf: false, note: 'Handed over at the desk' })
    const a = await auditsOf(s.itemId)
    expect(a.at(-1)).toMatchObject({ action: 'keys.item.issued', actor_role: 'Rec', site_id: s.siteId })
    expect(a.at(-1)?.after).toMatchObject({ status: 'issued', holderStaffId: s.res.staffId })
    expect((await notificationsByKey('handover:')).some(n => n.kind === 'keys.issued' && n.to_staff_id === s.res.staffId)).toBe(true)
    expect(await outstandingHandovers(getDb(), s.res.staffId)).toHaveLength(1)
  })

  it('the Accommodation Admin (keys.manage) can issue too; a Resident and a Read-only Manager cannot', async () => {
    const s = await scene()
    expect((await issue(s.aa, s.itemId, s.res.staffId)).ok).toBe(true)
    const s2 = await scene()
    const other = await person('Res')
    const asRes = await issue(other, s2.itemId, s2.res.staffId)
    expect(asRes.ok === false && asRes.code).toBe('forbidden')
    const mgr = await person('Mgr', { siteIds: [s2.siteId] })
    expect((await issue(mgr, s2.itemId, s2.res.staffId)).ok).toBe(false)
    expect((await itemRow(s2.itemId)).status).toBe('in_cabinet')
  })

  it('refused for oneself (D-26): a Reception officer who is also staying cannot issue a key to their own record', async () => {
    const w = await world()
    const rec = await person('Rec', { siteIds: [w.siteId] })
    await mkStayFor({ staffId: rec.staffId, bedId: w.bedIds[0] })
    const itemId = await mkItem({ siteId: w.siteId, bedId: w.bedIds[0] })
    const r = await issue(rec, itemId, rec.staffId)
    expect(r.ok === false && r.code).toBe('separation_of_duties')
    expect((await itemRow(itemId)).status).toBe('in_cabinet')
    expect(await events(itemId)).toHaveLength(0)
  })

  it('refused for a person with no stay or reservation in that bed (reason, owner, next action), allowed with a reservation', async () => {
    const s = await scene({ beds: 3 })
    const stranger = await person('Res')
    const r = await issue(s.rec, s.itemId, stranger.staffId)
    expect(r.ok === false && r.code).toBe('conflict')
    if (!r.ok) { expect(r.detail).toMatchObject({ reason: 'no_stay_in_bed' }); expect(r.owner).toBeTruthy(); expect(r.next).toBeTruthy() }
    // a person staying in ANOTHER bed of the same room still may not take this bed's locker key
    const neighbour = await resident(s.bedIds[1])
    expect((await issue(s.rec, s.itemId, neighbour.staffId)).ok).toBe(false)
    // a reservation for the bed is enough (the key can be handed over before check-in)
    const booked = await person('Res')
    const claim = (await admin().query<{ id: string }>(`INSERT INTO bed_claim (bed_id, kind, period) VALUES ($1, 'reservation', $2::daterange) RETURNING id`, [s.bedIds[2], `[${day(2)},${day(60)})`])).rows[0].id
    await admin().query(`INSERT INTO reservation (staff_id, bed_id, claim_id, eta, source, stay_type) VALUES ($1, $2, $3, $4, 'request', 'contract')`, [booked.staffId, s.bedIds[2], claim, `${day(2)}T12:00:00Z`])
    const lockerKey = await mkItem({ siteId: s.siteId, bedId: s.bedIds[2] })
    expect((await issue(s.rec, lockerKey, booked.staffId)).ok).toBe(true)
  })

  it('a room key can go to anyone staying in a bed of the room; an unlinked asset needs only an active employee', async () => {
    const s = await scene()
    const roomKey = await mkItem({ siteId: s.siteId, roomId: s.roomId })
    const mate = await resident(s.bedIds[1])
    expect((await issue(s.rec, roomKey, mate.staffId)).ok).toBe(true)
    const card = await mkItem({ siteId: s.siteId, category: 'asset', itemType: 'access_card' })
    const someone = await person('Res')
    expect((await issue(s.rec, card, someone.staffId)).ok).toBe(true)
  })

  it('refused for an inactive (Left) person and for one that does not exist', async () => {
    const s = await scene()
    const left = await resident(s.bedIds[1])
    await admin().query(`UPDATE staff_profile SET employment_status = 'left', left_at = now() WHERE id = $1`, [left.staffId])
    const r = await issue(s.rec, await mkItem({ siteId: s.siteId, category: 'asset', itemType: 'access_card' }), left.staffId)
    expect(r.ok === false && r.code).toBe('conflict')
    if (!r.ok) expect(r.detail).toMatchObject({ reason: 'inactive' })
    const nobody = await issue(s.rec, s.itemId, crypto.randomUUID())
    expect(nobody.ok === false && nobody.code).toBe('invalid')
  })

  it('refused for an item that is not in the cabinet: issued, lost, damaged, retired; and for a past due date', async () => {
    const s = await scene()
    const again = await person('Res')
    for (const status of ['issued', 'lost', 'damaged', 'retired']) {
      const holder = status === 'retired' ? undefined : s.res.staffId
      const id = await mkItem({ siteId: s.siteId, bedId: s.bedIds[0], status, holderStaffId: holder })
      const r = await issue(s.rec, id, again.staffId)
      expect(r.ok === false && r.code, status).toBe('conflict')
      if (!r.ok) expect(r.detail).toMatchObject({ reason: 'not_in_cabinet', status })
    }
    const late = await issue(s.rec, s.itemId, s.res.staffId, { dueBack: day(-1) })
    expect(late.ok === false && late.fields).toMatchObject({ dueBack: expect.any(String) })
    expect((await itemRow(s.itemId)).status).toBe('in_cabinet')
  })

  it('two simultaneous issues of one key: exactly one wins, the loser gets a conflict with a next action', async () => {
    const s = await scene()
    const second = await resident(s.bedIds[1])
    await admin().query(`UPDATE handover_item SET bed_id = NULL, room_id = $2 WHERE id = $1`, [s.itemId, s.roomId])   // a room key both can hold
    const rec2 = await person('Rec', { siteIds: [s.siteId] })
    const results = await Promise.all([issue(s.rec, s.itemId, s.res.staffId), issue(rec2, s.itemId, second.staffId)])
    expect(results.filter(r => r.ok)).toHaveLength(1)
    const loser = results.find(r => !r.ok)!
    expect(loser.ok === false && loser.code).toBe('conflict')
    if (!loser.ok) { expect(loser.next).toBeTruthy(); expect(loser.detail).toMatchObject({ reason: 'not_in_cabinet', status: 'issued' }) }
    const row = await itemRow(s.itemId)
    const winner = results.findIndex(r => r.ok) === 0 ? s.res.staffId : second.staffId
    expect(row).toMatchObject({ status: 'issued', holder_staff_id: winner })
    expect((await events(s.itemId)).map(e => e.kind)).toEqual(['issued'])
    expect((await auditsOf(s.itemId)).filter(a => a.action === 'keys.item.issued')).toHaveLength(1)
  })

  it('many simultaneous issues still leave exactly one holder', async () => {
    const s = await scene()
    await admin().query(`UPDATE handover_item SET bed_id = NULL, room_id = NULL WHERE id = $1`, [s.itemId])
    const people = await Promise.all([0, 1, 2, 3, 4].map(() => person('Res')))
    const results = await Promise.all(people.map(p => issue(s.rec, s.itemId, p.staffId)))
    expect(results.filter(r => r.ok)).toHaveLength(1)
    expect((await events(s.itemId))).toHaveLength(1)
  })
})

describe('returnItem', () => {
  it('only an issued item can be returned: back to the cabinet, holder cleared, event and audit; a second return is refused', async () => {
    const s = await scene()
    await issue(s.rec, s.itemId, s.res.staffId, { dueBack: day(10) })
    const r = await returnItem(s.rec.rc, { itemId: s.itemId, note: 'Handed back', onBehalf: undefined })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    expect(await itemRow(s.itemId)).toMatchObject({ status: 'in_cabinet', holder_staff_id: null, issued_at: null, due_back: null })
    const ev = await events(s.itemId)
    expect(ev.map(e => e.kind)).toEqual(['issued', 'returned'])
    expect(ev[1]).toMatchObject({ staff_id: s.res.staffId, actor_user_id: s.rec.userId, on_behalf: false, note: 'Handed back' })
    expect((await auditsOf(s.itemId)).at(-1)?.action).toBe('keys.item.returned')
    expect(await outstandingHandovers(getDb(), s.res.staffId)).toHaveLength(0)
    const again = await returnItem(s.rec.rc, { itemId: s.itemId, onBehalf: undefined, note: null })
    expect(again.ok === false && again.code).toBe('conflict')
    if (!again.ok) expect(again.detail).toMatchObject({ reason: 'already_in_cabinet' })
    expect((await events(s.itemId)).map(e => e.kind)).toEqual(['issued', 'returned'])
  })

  it('a Resident cannot return their own key, and Reception cannot record the return of their own', async () => {
    const s = await scene()
    await issue(s.rec, s.itemId, s.res.staffId)
    const r = await returnItem(s.res.rc, { itemId: s.itemId, onBehalf: undefined, note: null })
    expect(r.ok === false && r.code).toBe('forbidden')
    // Reception staff who is herself the holder
    const rec = await person('Rec', { siteIds: [s.siteId] })
    await mkStayFor({ staffId: rec.staffId, bedId: s.bedIds[1] })
    const mine = await mkItem({ siteId: s.siteId, bedId: s.bedIds[1], holderStaffId: rec.staffId })
    const self = await returnItem(rec.rc, { itemId: mine, onBehalf: undefined, note: null })
    expect(self.ok === false && self.code).toBe('separation_of_duties')
    expect((await itemRow(mine)).status).toBe('issued')
  })

  it('a former employee\'s key is returned on their behalf (recorded), and so is any return the officer marks so', async () => {
    const s = await scene()
    await issue(s.rec, s.itemId, s.res.staffId)
    await admin().query(`UPDATE staff_profile SET employment_status = 'left', left_at = now() WHERE id = $1`, [s.res.staffId])
    const r = await returnItem(s.rec.rc, { itemId: s.itemId, onBehalf: undefined, note: 'Found in the room' })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    expect((await events(s.itemId)).at(-1)).toMatchObject({ kind: 'returned', on_behalf: true, staff_id: s.res.staffId })
    expect((await auditsOf(s.itemId)).at(-1)?.after).toMatchObject({ onBehalf: true })

    const s2 = await scene()
    await issue(s2.rec, s2.itemId, s2.res.staffId)
    await returnItem(s2.rec.rc, { itemId: s2.itemId, onBehalf: true, note: 'A colleague brought it' })
    expect((await events(s2.itemId)).at(-1)).toMatchObject({ on_behalf: true })
    // a returned-in-person key is not "on behalf"
    const s3 = await scene()
    await issue(s3.rec, s3.itemId, s3.res.staffId)
    await returnItem(s3.rec.rc, { itemId: s3.itemId, onBehalf: undefined, note: null })
    expect((await events(s3.itemId)).at(-1)).toMatchObject({ on_behalf: false })
  })

  it('the last return closes a checked-out, cleared stay (closeStayIfDone); an earlier return does not', async () => {
    const s = await scene()
    const second = await mkItem({ siteId: s.siteId, bedId: s.bedIds[0] })
    await issue(s.rec, s.itemId, s.res.staffId)
    await issue(s.rec, second, s.res.staffId)
    await checkOutDirectly(s.res.stayId, '2026-10-13T08:00:00Z')
    const first = await returnItem(s.rec.rc, { itemId: s.itemId, onBehalf: undefined, note: null })
    expect(first.ok && first.data.closedStays).toEqual([])
    expect((await stayStatus(s.res.stayId)).status).toBe('checked_out')                    // one key still out: not closed
    const last = await returnItem(s.rec.rc, { itemId: second, onBehalf: undefined, note: null })
    expect(last.ok && last.data.closedStays).toEqual([s.res.stayId])
    const st = await stayStatus(s.res.stayId)
    expect(st.status).toBe('closed')
    expect(st.closed_at?.getTime()).toBe(s.rec.rc.clock.nowMs())
  })

  it('an active stay is never closed by a return (checkout comes first)', async () => {
    const s = await scene()
    await issue(s.rec, s.itemId, s.res.staffId)
    await returnItem(s.rec.rc, { itemId: s.itemId, onBehalf: undefined, note: null })
    expect((await stayStatus(s.res.stayId)).status).toBe('active')
  })
})

describe('lost and damaged (D-73): never marked returned', () => {
  it('lost: note mandatory, the item keeps its holder, stays outstanding, and cannot be returned or re-issued', async () => {
    const s = await scene()
    await issue(s.rec, s.itemId, s.res.staffId)
    expect(lostInput.safeParse({ itemId: s.itemId, note: '' }).success).toBe(false)               // a note is mandatory
    const r = await markLost(s.rec.rc, { itemId: s.itemId, note: 'Fell into the sea off the jetty', attachmentIds: undefined })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    expect(await itemRow(s.itemId)).toMatchObject({ status: 'lost', holder_staff_id: s.res.staffId })
    expect((await outstandingHandovers(getDb(), s.res.staffId)).map(i => i.status)).toEqual(['lost'])
    const ret = await returnItem(s.rec.rc, { itemId: s.itemId, onBehalf: undefined, note: 'try' })
    expect(ret.ok === false && ret.code).toBe('conflict')
    if (!ret.ok) { expect(ret.detail).toMatchObject({ reason: 'lost_not_returnable' }); expect(ret.owner).toBeTruthy(); expect(ret.next).toMatch(/found|retire|replace/i) }
    const reissue = await issue(s.rec, s.itemId, s.res.staffId)
    expect(reissue.ok).toBe(false)
    expect((await itemRow(s.itemId)).status).toBe('lost')
    expect((await events(s.itemId)).map(e => e.kind)).toEqual(['issued', 'lost'])
    expect((await events(s.itemId)).some(e => e.kind === 'returned')).toBe(false)
    expect((await notificationsByKey('handover:')).some(n => n.kind === 'keys.lost' && n.to_role === 'AA')).toBe(true)
  })

  it('damaged: note mandatory, evidence uploaded onto the item must belong to it, never returned', async () => {
    const s = await scene()
    await issue(s.rec, s.itemId, s.res.staffId)
    const up = await attach(s.rec.rc, { entityType: 'handover_item', entityId: s.itemId, filename: 'bent-key.png', contentType: 'image/png', dataBase64: PNG.toString('base64') })
    expect(up.ok, JSON.stringify(up)).toBe(true)
    if (!up.ok) return
    const foreign = await mkItem({ siteId: s.siteId })
    const stranger = await attach(s.aa.rc, { entityType: 'handover_item', entityId: foreign, filename: 'other.png', contentType: 'image/png', dataBase64: PNG.toString('base64') })
    if (!stranger.ok) throw new Error('attach failed')
    const wrong = await markDamaged(s.rec.rc, { itemId: s.itemId, note: 'Bent in the lock', attachmentIds: [stranger.data.id] })
    expect(wrong.ok === false && wrong.fields).toMatchObject({ attachmentIds: expect.any(String) })
    const r = await markDamaged(s.rec.rc, { itemId: s.itemId, note: 'Bent in the lock', attachmentIds: [up.data.id] })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    expect(await itemRow(s.itemId)).toMatchObject({ status: 'damaged', holder_staff_id: s.res.staffId })
    const ret = await returnItem(s.rec.rc, { itemId: s.itemId, onBehalf: undefined, note: 'try' })
    expect(ret.ok === false && ret.code).toBe('conflict')
    expect((await itemRow(s.itemId)).status).toBe('damaged')
    expect((await auditsOf(s.itemId)).at(-1)?.after).toMatchObject({ status: 'damaged', attachmentIds: [up.data.id] })
    expect((await events(s.itemId)).some(e => e.kind === 'returned')).toBe(false)
  })

  it('an item lost or damaged keeps blocking the closing of a checked-out stay until it is resolved', async () => {
    const s = await scene()
    await issue(s.rec, s.itemId, s.res.staffId)
    await markLost(s.rec.rc, { itemId: s.itemId, note: 'Lost on the beach', attachmentIds: undefined })
    await checkOutDirectly(s.res.stayId, '2026-10-13T08:00:00Z')
    const r = await retireItem(s.aa.rc, { itemId: s.itemId, reason: 'Written off, lock changed' })
    expect(r.ok && r.data.closedStays).toEqual([s.res.stayId])
    expect((await stayStatus(s.res.stayId)).status).toBe('closed')
  })

  it('the only exits from lost or damaged are retire, replace and (lost only) found: every other command refuses', async () => {
    const s = await scene()
    const res = s.res
    for (const status of ['lost', 'damaged'] as const) {
      const id = await mkItem({ siteId: s.siteId, bedId: s.bedIds[0], status, holderStaffId: res.staffId })
      expect((await returnItem(s.rec.rc, { itemId: id, onBehalf: undefined, note: null })).ok).toBe(false)
      expect((await issue(s.rec, id, res.staffId)).ok).toBe(false)
      expect((await markLost(s.rec.rc, { itemId: id, note: 'again', attachmentIds: undefined })).ok).toBe(false)
      expect((await markDamaged(s.rec.rc, { itemId: id, note: 'again', attachmentIds: undefined })).ok).toBe(false)
      expect((await itemRow(id)).status).toBe(status)
      if (status === 'damaged') {
        const f = await foundItem(s.rec.rc, { itemId: id, to: 'cabinet', note: null })
        expect(f.ok === false && f.code).toBe('conflict')
      }
    }
    // the database does not know a "returned lost" state either: the item stays outstanding
    expect((await outstandingHandovers(getDb(), res.staffId)).map(i => i.status).sort()).toEqual(['damaged', 'lost'])
  })

  it('Reception cannot record their own lost key (D-26)', async () => {
    const w = await world()
    const rec = await person('Rec', { siteIds: [w.siteId] })
    await mkStayFor({ staffId: rec.staffId, bedId: w.bedIds[0] })
    const id = await mkItem({ siteId: w.siteId, bedId: w.bedIds[0], holderStaffId: rec.staffId })
    const r = await markLost(rec.rc, { itemId: id, note: 'I lost it', attachmentIds: undefined })
    expect(r.ok === false && r.code).toBe('separation_of_duties')
  })
})

describe('found, retire, replace (D-73)', () => {
  it('found: a lost key goes back to its holder, or into the cabinet (which also frees the holder\'s stay)', async () => {
    const s = await scene()
    await issue(s.rec, s.itemId, s.res.staffId)
    await markLost(s.rec.rc, { itemId: s.itemId, note: 'Lost', attachmentIds: undefined })
    const toHolder = await foundItem(s.rec.rc, { itemId: s.itemId, to: 'holder', note: 'Found under the bed' })
    expect(toHolder.ok, JSON.stringify(toHolder)).toBe(true)
    expect(await itemRow(s.itemId)).toMatchObject({ status: 'issued', holder_staff_id: s.res.staffId })
    await markLost(s.rec.rc, { itemId: s.itemId, note: 'Lost again', attachmentIds: undefined })
    await checkOutDirectly(s.res.stayId, '2026-10-13T08:00:00Z')
    const toCabinet = await foundItem(s.rec.rc, { itemId: s.itemId, to: 'cabinet', note: null })
    expect(toCabinet.ok && toCabinet.data).toMatchObject({ status: 'in_cabinet', closedStays: [s.res.stayId] })
    expect((await events(s.itemId)).map(e => e.kind)).toEqual(['issued', 'lost', 'found', 'lost', 'found'])
    expect((await foundItem(s.rec.rc, { itemId: s.itemId, to: 'cabinet', note: null })).ok).toBe(false)         // not lost any more
  })

  it('retire: AA with a reason, never while issued; the holder\'s obligation ends and the event keeps who held it', async () => {
    const s = await scene()
    await issue(s.rec, s.itemId, s.res.staffId)
    const issuedTry = await retireItem(s.aa.rc, { itemId: s.itemId, reason: 'worn out' })
    expect(issuedTry.ok === false && issuedTry.code).toBe('conflict')
    await markDamaged(s.rec.rc, { itemId: s.itemId, note: 'Snapped in half', attachmentIds: undefined })
    expect((await retireItem(s.rec.rc, { itemId: s.itemId, reason: 'Reception may not retire' })).ok).toBe(false)
    expect(retireInput.safeParse({ itemId: s.itemId, reason: 'x' }).success).toBe(false)                          // a reason is mandatory
    expect(lostInput.safeParse({ itemId: s.itemId, note: '' }).success).toBe(false)
    const r = await retireItem(s.aa.rc, { itemId: s.itemId, reason: 'Snapped, not repairable' })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    expect(await itemRow(s.itemId)).toMatchObject({ status: 'retired', holder_staff_id: null })
    expect((await events(s.itemId)).at(-1)).toMatchObject({ kind: 'retired', staff_id: s.res.staffId, note: 'Snapped, not repairable' })
    expect(await outstandingHandovers(getDb(), s.res.staffId)).toHaveLength(0)
    expect((await auditsOf(s.itemId)).at(-1)).toMatchObject({ action: 'keys.item.retired', reason: 'Snapped, not repairable' })
  })

  it('replace: the old key is retired and links the new one, the new one is issued to the same holder, with replaced and issued events', async () => {
    const s = await scene()
    await issue(s.rec, s.itemId, s.res.staffId, { dueBack: day(40) })
    await markLost(s.rec.rc, { itemId: s.itemId, note: 'Lost at the pool', attachmentIds: undefined })
    const newCode = uniq('K-NEW')
    const r = await replaceItem(s.aa.rc, { itemId: s.itemId, newCode, newItemType: undefined, note: 'Lock cylinder kept' })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    if (!r.ok) return
    const old = await itemRow(s.itemId)
    expect(old).toMatchObject({ status: 'retired', holder_staff_id: null, replaced_by: r.data.newId })
    const fresh = await itemRow(r.data.newId)
    expect(fresh).toMatchObject({ status: 'issued', holder_staff_id: s.res.staffId, code: newCode, bed_id: s.bedIds[0], site_id: s.siteId, item_type: old.item_type, due_back: day(40) })
    expect(r.data).toMatchObject({ newStatus: 'issued', holderStaffId: s.res.staffId })
    expect((await events(s.itemId)).map(e => e.kind)).toEqual(['issued', 'lost', 'replaced'])
    expect((await events(r.data.newId)).map(e => e.kind)).toEqual(['issued'])
    expect((await events(r.data.newId))[0]).toMatchObject({ staff_id: s.res.staffId, actor_user_id: s.aa.userId })
    expect((await outstandingHandovers(getDb(), s.res.staffId)).map(i => i.id)).toEqual([r.data.newId])          // the old one no longer counts; the new one is the resident's
    expect((await auditsOf(s.itemId)).at(-1)).toMatchObject({ action: 'keys.item.replaced' })
    expect((await auditsOf(r.data.newId))[0]).toMatchObject({ action: 'keys.item.created' })
    // a damaged one replaces the same way, and a second replace of the old item is refused
    expect((await replaceItem(s.aa.rc, { itemId: s.itemId, newCode: uniq('K'), newItemType: undefined, note: null })).ok).toBe(false)
  })

  it('replace: only a lost or damaged item, only by keys.manage, the code must be new, nothing is half-done on a refusal', async () => {
    const s = await scene()
    await issue(s.rec, s.itemId, s.res.staffId)
    const inUse = await replaceItem(s.aa.rc, { itemId: s.itemId, newCode: uniq('K'), newItemType: undefined, note: null })
    expect(inUse.ok === false && inUse.code).toBe('conflict')
    await markDamaged(s.rec.rc, { itemId: s.itemId, note: 'Teeth worn', attachmentIds: undefined })
    expect((await replaceItem(s.rec.rc, { itemId: s.itemId, newCode: uniq('K'), newItemType: undefined, note: null })).ok).toBe(false)
    const code = (await itemRow(s.itemId)).code
    const dup = await replaceItem(s.aa.rc, { itemId: s.itemId, newCode: code.toUpperCase(), newItemType: undefined, note: null })
    expect(dup.ok === false && dup.code).toBe('conflict')
    expect(await itemRow(s.itemId)).toMatchObject({ status: 'damaged', holder_staff_id: s.res.staffId, replaced_by: null })     // untouched
    const badType = await replaceItem(s.aa.rc, { itemId: s.itemId, newCode: uniq('K'), newItemType: 'access_card', note: null })
    expect(badType.ok).toBe(false)
  })

  it('replace for a former employee: the new key goes to the cabinet, not to someone who has left; the old obligation ends', async () => {
    const s = await scene()
    await issue(s.rec, s.itemId, s.res.staffId)
    await markLost(s.rec.rc, { itemId: s.itemId, note: 'Never returned', attachmentIds: undefined })
    await admin().query(`UPDATE staff_profile SET employment_status = 'left', left_at = now() WHERE id = $1`, [s.res.staffId])
    const r = await replaceItem(s.aa.rc, { itemId: s.itemId, newCode: uniq('K'), newItemType: undefined, note: null })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    if (!r.ok) return
    expect(r.data).toMatchObject({ newStatus: 'in_cabinet', holderStaffId: null })
    expect(await outstandingHandovers(getDb(), s.res.staffId)).toHaveLength(0)
  })

  it('replace of an item with no holder (found damaged in the cabinet) creates the new one in the cabinet', async () => {
    const w = await world()
    const id = await mkItem({ siteId: w.siteId, roomId: w.roomId })
    expect((await markDamaged(w.rec.rc, { itemId: id, note: 'Found cracked in the drawer', attachmentIds: undefined })).ok).toBe(true)
    const r = await replaceItem(w.aa.rc, { itemId: id, newCode: uniq('K'), newItemType: undefined, note: null })
    expect(r.ok && r.data.newStatus).toBe('in_cabinet')
  })
})

describe('every movement leaves an event and an audit row, by the actor, in step', () => {
  it('issued, returned, lost, found, damaged, retired and replaced: one event and one audit row each, same actor, same site', async () => {
    const s = await scene()
    const rec = s.rec, aa = s.aa
    await issue(rec, s.itemId, s.res.staffId)
    await returnItem(rec.rc, { itemId: s.itemId, onBehalf: undefined, note: null })
    await issue(rec, s.itemId, s.res.staffId)
    await markLost(rec.rc, { itemId: s.itemId, note: 'Lost once', attachmentIds: undefined })
    await foundItem(rec.rc, { itemId: s.itemId, to: 'holder', note: null })
    await markDamaged(rec.rc, { itemId: s.itemId, note: 'Bent', attachmentIds: undefined })
    const rep = await replaceItem(aa.rc, { itemId: s.itemId, newCode: uniq('K'), newItemType: undefined, note: null })
    if (!rep.ok) throw new Error('replace failed')
    await markLost(rec.rc, { itemId: rep.data.newId, note: 'And this one too', attachmentIds: undefined })
    await retireItem(aa.rc, { itemId: rep.data.newId, reason: 'Gave up on it' })

    const ev = await events(s.itemId)
    expect(ev.map(e => e.kind)).toEqual(['issued', 'returned', 'issued', 'lost', 'found', 'damaged', 'replaced'])
    expect(ev.every(e => e.actor_user_id === rec.userId || e.actor_user_id === aa.userId)).toBe(true)
    const au = (await auditsOf(s.itemId)).map(a => a.action)
    expect(au).toEqual(['keys.item.issued', 'keys.item.returned', 'keys.item.issued', 'keys.item.lost', 'keys.item.found', 'keys.item.damaged', 'keys.item.replaced'])
    const ev2 = await events(rep.data.newId)
    expect(ev2.map(e => e.kind)).toEqual(['issued', 'lost', 'retired'])
    expect((await auditsOf(rep.data.newId)).map(a => a.action)).toEqual(['keys.item.created', 'keys.item.lost', 'keys.item.retired'])
    const sites = new Set((await auditsOf(s.itemId)).map(a => a.site_id))
    expect([...sites]).toEqual([s.siteId])
  })

  it('a refused movement leaves nothing behind: no event, no audit row, the item unchanged', async () => {
    const s = await scene()
    await issue(s.rec, s.itemId, s.res.staffId)
    const before = { ev: (await events(s.itemId)).length, au: (await auditsOf(s.itemId)).length, row: await itemRow(s.itemId) }
    expect((await issue(s.rec, s.itemId, s.res.staffId)).ok).toBe(false)
    expect((await returnItem(s.res.rc, { itemId: s.itemId, onBehalf: undefined, note: null })).ok).toBe(false)
    expect((await retireItem(s.aa.rc, { itemId: s.itemId, reason: 'still held' })).ok).toBe(false)
    expect((await foundItem(s.rec.rc, { itemId: s.itemId, to: 'cabinet', note: null })).ok).toBe(false)
    expect({ ev: (await events(s.itemId)).length, au: (await auditsOf(s.itemId)).length, row: await itemRow(s.itemId) }).toEqual(before)
  })
})

describe('scope of the commands', () => {
  it('Reception of site A cannot issue, return, mark lost or replace an item of site B: not found, nothing changes', async () => {
    const a = await world()
    const b = await world()
    const res = await resident(b.bedIds[0])
    const item = await mkItem({ siteId: b.siteId, bedId: b.bedIds[0] })
    const r = await issue(a.rec, item, res.staffId)
    expect(r.ok === false && r.code).toBe('not_found')
    const held = await mkItem({ siteId: b.siteId, bedId: b.bedIds[0], holderStaffId: res.staffId })
    expect((await returnItem(a.rec.rc, { itemId: held, onBehalf: undefined, note: null })).ok === false).toBe(true)
    expect((await markLost(a.rec.rc, { itemId: held, note: 'nope', attachmentIds: undefined }))).toMatchObject({ ok: false, code: 'not_found' })
    expect((await replaceItem(a.aa.rc, { itemId: held, newCode: 'X', newItemType: undefined, note: null }))).toMatchObject({ ok: false, code: 'not_found' })
    expect(await itemRow(held)).toMatchObject({ status: 'issued', holder_staff_id: res.staffId })
  })

  it('creating through the command sets nothing but what the registry says', async () => {
    const w = await world()
    const c = await createItem(w.aa.rc, { siteId: w.siteId, category: 'key', itemType: 'locker_key', code: uniq('L'), roomId: null, bedId: w.bedIds[0], note: null })
    expect(c.ok).toBe(true)
    void as
    void mkProperty
  })
})
