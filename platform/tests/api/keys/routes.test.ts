/**
 * WP-I through the real routes: scope (a site, a resident), Night Keys, the answers a screen relies on (409 with owner and next
 * action, 422 with fields), evidence upload, keys for a stay and the keys to swap after a transfer (D-61), the archive checks.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { call, closeAll, uniq } from '../harness'
import { actor, send } from '../fixtures2'
import { mkItem, mkProperty, mkRoom, mkStayFor, person, resident, world, itemRow, events } from './helpers'
import { PNG } from '../fixtures3'
import { GET as list, POST as create } from '../../../app/api/v1/keys/route'
import { GET as detail } from '../../../app/api/v1/keys/[id]/route'
import { POST as issue } from '../../../app/api/v1/keys/[id]/issue/route'
import { POST as ret } from '../../../app/api/v1/keys/[id]/return/route'
import { POST as lost } from '../../../app/api/v1/keys/[id]/lost/route'
import { POST as damaged } from '../../../app/api/v1/keys/[id]/damaged/route'
import { POST as retire } from '../../../app/api/v1/keys/[id]/retire/route'
import { POST as replace } from '../../../app/api/v1/keys/[id]/replace/route'
import { POST as found } from '../../../app/api/v1/keys/[id]/found/route'
import { POST as archive } from '../../../app/api/v1/keys/[id]/archive/route'
import { GET as people } from '../../../app/api/v1/keys/people/route'
import { GET as forStay } from '../../../app/api/v1/keys/stays/[id]/route'
import { POST as upload } from '../../../app/api/v1/attachments/route'
import { archiveBed } from '@/server/commands/property/archiveBed'
import { archiveRoom } from '@/server/commands/property/archiveRoom'
import { keysToSwapForStay, keysForStay } from '@/server/queries/keys/items'
import { retireItem } from '@/server/commands/keys/movements'
import { returnItem } from '@/server/commands/keys/movements'

afterAll(closeAll)

const P = '/api/v1/keys'
const get = (h: Parameters<typeof call>[0], a: Awaited<ReturnType<typeof actor>> | undefined, o: { id?: string; path?: string } = {}) =>
  call(h, { path: o.path ?? P, cookie: a?.cookie, params: o.id ? { id: o.id } : undefined })

describe('who sees what (scope in SQL)', () => {
  it('Reception of site A sees site A items and gets 404 for a site B item; Super Admin sees both', async () => {
    const a = await mkProperty({ beds: 1 }), b = await mkProperty({ beds: 1 })
    const rec = await actor('Rec', { siteIds: [a.siteId] })
    const inA = await mkItem({ siteId: a.siteId, bedId: a.bedIds[0] })
    const inB = await mkItem({ siteId: b.siteId, bedId: b.bedIds[0] })
    const l = await get(list, rec)
    expect(l.status).toBe(200)
    const ids = l.body.data.rows.map((r: { id: string }) => r.id)
    expect(ids).toContain(inA)
    expect(ids).not.toContain(inB)
    expect((await get(detail, rec, { id: inA })).status).toBe(200)
    expect((await get(detail, rec, { id: inB })).status).toBe(404)
    expect((await get(detail, rec, { id: 'not-a-uuid' })).status).toBe(404)
    const sa = await actor('SA')
    expect((await get(list, sa)).body.data.rows.map((r: { id: string }) => r.id)).toEqual(expect.arrayContaining([inA, inB]))
    // a site filter outside the actor's sites shows nothing rather than failing
    const other = await get(list, rec, { path: `${P}?siteId=${b.siteId}` })
    expect(other.body.data.rows).toHaveLength(0)
  })

  it('a Resident sees only the items they hold, never another resident\'s, and cannot hand anything out', async () => {
    const w = await world({ beds: 2 })
    const mine = await resident(w.bedIds[0])
    const theirs = await resident(w.bedIds[1])
    const myItem = await mkItem({ siteId: w.siteId, bedId: w.bedIds[0], holderStaffId: mine.staffId })
    const theirItem = await mkItem({ siteId: w.siteId, bedId: w.bedIds[1], holderStaffId: theirs.staffId })
    const cabinetItem = await mkItem({ siteId: w.siteId, bedId: w.bedIds[0] })
    const me = { user: mine.user, cookie: await (await import('../harness')).signIn(mine.user) }
    const l = await get(list, me)
    expect(l.status).toBe(200)
    expect(l.body.data.rows.map((r: { id: string }) => r.id)).toEqual([myItem])
    expect((await get(detail, me, { id: myItem })).status).toBe(200)
    expect((await get(detail, me, { id: theirItem })).status).toBe(404)
    expect((await get(detail, me, { id: cabinetItem })).status).toBe(404)
    const d = (await get(detail, me, { id: myItem })).body.data
    expect(d.events.every((e: { actor: unknown }) => e.actor === null)).toBe(true)           // what happened, not who did it
    expect((await send(ret, me, { id: myItem, body: {}, path: `${P}/x/return` })).status).toBe(403)
    expect((await send(issue, me, { id: cabinetItem, body: { staffId: mine.staffId }, path: `${P}/x/issue` })).status).toBe(403)
    expect((await send(people, me, { path: `${P}/people?employeeId=${mine.employeeId}` })).status).toBe(404)
  })

  it('a Read-only Manager and a Technician see nothing; an Auditor reads but cannot change', async () => {
    const w = await world({ beds: 1 })
    const item = await mkItem({ siteId: w.siteId, bedId: w.bedIds[0] })
    const mgr = await actor('Mgr', { siteIds: [w.siteId] })
    expect((await get(list, mgr)).status).toBe(403)
    const aud = await actor('Aud', { siteIds: [w.siteId] })
    expect((await get(detail, aud, { id: item })).status).toBe(200)
    const res = await resident(w.bedIds[0])
    expect((await send(issue, aud, { id: item, body: { staffId: res.staffId }, path: `${P}/x/issue` })).status).toBe(403)
    expect((await itemRow(item)).status).toBe('in_cabinet')
  })
})

describe('Night Keys (a capability on Security)', () => {
  it('Security with the Night Keys capability sees the cabinet and can issue and return; Security without it cannot', async () => {
    const w = await world({ beds: 1 })
    const res = await resident(w.bedIds[0])
    const item = await mkItem({ siteId: w.siteId, bedId: w.bedIds[0] })
    const night = await actor('Sec', { siteIds: [w.siteId], caps: ['NightKeys'] })
    const plain = await actor('Sec', { siteIds: [w.siteId] })

    expect((await get(list, plain)).status).toBe(403)
    const no = await send(issue, plain, { id: item, body: { staffId: res.staffId }, path: `${P}/x/issue` })
    expect(no.status).toBe(403)
    expect((await itemRow(item)).status).toBe('in_cabinet')

    expect((await get(list, night)).body.data.rows.map((r: { id: string }) => r.id)).toContain(item)
    const f = await send(people, night, { path: `${P}/people?employeeId=${res.employeeId}&itemId=${item}` })
    expect(f.status).toBe(200)
    expect(f.body.data).toMatchObject({ id: res.staffId, canHold: true, problem: null })
    const ok = await send(issue, night, { id: item, body: { staffId: res.staffId }, path: `${P}/x/issue` })
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    expect(await itemRow(item)).toMatchObject({ status: 'issued', holder_staff_id: res.staffId })
    const back = await send(ret, night, { id: item, body: {}, path: `${P}/x/return` })
    expect(back.status).toBe(200)
    expect((await itemRow(item)).status).toBe('in_cabinet')
    // Night Keys never reaches another site
    const elsewhere = await mkProperty({ beds: 1 })
    const foreign = await mkItem({ siteId: elsewhere.siteId, bedId: elsewhere.bedIds[0] })
    expect((await send(issue, night, { id: foreign, body: { staffId: res.staffId }, path: `${P}/x/issue` })).status).toBe(404)
    // a Security officer cannot retire or replace even with Night Keys (keys.manage only)
    expect((await send(retire, night, { id: item, body: { reason: 'nope nope' }, path: `${P}/x/retire` })).status).toBe(403)
  })
})

describe('the answers a screen relies on', () => {
  it('validation is 422 with fields; a refusal is 409 with reason, owner and next action', async () => {
    const w = await world({ beds: 1 })
    const res = await resident(w.bedIds[0])
    const rec = await actor('Rec', { siteIds: [w.siteId] })
    const item = await mkItem({ siteId: w.siteId, bedId: w.bedIds[0], holderStaffId: res.staffId })
    const bad = await send(issue, rec, { id: item, body: { staffId: 'x' }, path: `${P}/x/issue` })
    expect(bad.status).toBe(422)
    expect(bad.body.fields).toHaveProperty('staffId')
    const taken = await send(issue, rec, { id: item, body: { staffId: res.staffId }, path: `${P}/x/issue` })
    expect(taken.status).toBe(409)
    expect(taken.body).toMatchObject({ code: 'conflict', detail: { reason: 'not_in_cabinet', status: 'issued' } })
    expect(taken.body.reason).toBeTruthy(); expect(taken.body.owner).toBeTruthy(); expect(taken.body.next).toBeTruthy()
    const noNote = await send(lost, rec, { id: item, body: { note: '' }, path: `${P}/x/lost` })
    expect(noNote.status).toBe(422)
    expect(noNote.body.fields).toHaveProperty('note')
  })

  it('the whole life of a key through the routes: create, issue, lost, replaced, new key returned, old one retired', async () => {
    const w = await world({ beds: 1 })
    const res = await resident(w.bedIds[0])
    const aa = await actor('AA', { siteIds: [w.siteId] })
    const rec = await actor('Rec', { siteIds: [w.siteId] })
    const code = uniq('K')
    const made = await send(create, aa, { body: { siteId: w.siteId, category: 'key', itemType: 'room_key', code, bedId: w.bedIds[0] } })
    expect(made.status, JSON.stringify(made.body)).toBe(200)
    const id = made.body.data.id as string
    expect((await send(create, rec, { body: { siteId: w.siteId, category: 'key', itemType: 'room_key', code: uniq('K') } })).status).toBe(403)
    expect((await send(issue, rec, { id, body: { staffId: res.staffId }, path: `${P}/x/issue` })).status).toBe(200)
    expect((await send(lost, rec, { id, body: { note: 'Fell off the balcony' }, path: `${P}/x/lost` })).status).toBe(200)
    const tryReturn = await send(ret, rec, { id, body: {}, path: `${P}/x/return` })
    expect(tryReturn.status).toBe(409)
    expect((await itemRow(id)).status).toBe('lost')
    const rep = await send(replace, aa, { id, body: { newCode: uniq('K-NEW') }, path: `${P}/x/replace` })
    expect(rep.status, JSON.stringify(rep.body)).toBe(200)
    expect(rep.body.data).toMatchObject({ newStatus: 'issued', holderStaffId: res.staffId })
    const old = await itemRow(id)
    expect(old).toMatchObject({ status: 'retired', replaced_by: rep.body.data.newId })
    const d = await get(detail, aa, { id })
    expect(d.body.data).toMatchObject({ status: 'retired', replacedBy: { id: rep.body.data.newId } })
    expect(d.body.data.events.map((e: { kind: string }) => e.kind)).toEqual(['replaced', 'lost', 'issued'])        // newest first
    expect((await get(detail, aa, { id: rep.body.data.newId })).body.data.replaces).toMatchObject({ id })
    expect((await send(ret, rec, { id: rep.body.data.newId, body: {}, path: `${P}/x/return` })).status).toBe(200)
    expect((await send(archive, aa, { id, body: { reason: 'Old key written off' }, path: `${P}/x/archive` })).status).toBe(200)
    expect((await events(id)).map(e => e.kind)).toEqual(['issued', 'lost', 'replaced'])
  })

  it('found and retire through the routes', async () => {
    const w = await world({ beds: 1 })
    const res = await resident(w.bedIds[0])
    const aa = await actor('AA', { siteIds: [w.siteId] })
    const rec = await actor('Rec', { siteIds: [w.siteId] })
    const item = await mkItem({ siteId: w.siteId, bedId: w.bedIds[0], holderStaffId: res.staffId })
    expect((await send(lost, rec, { id: item, body: { note: 'Not in the room' }, path: `${P}/x/lost` })).status).toBe(200)
    expect((await send(found, rec, { id: item, body: { to: 'holder' }, path: `${P}/x/found` })).status).toBe(200)
    expect((await itemRow(item)).status).toBe('issued')
    expect((await send(damaged, rec, { id: item, body: { note: 'Snapped' }, path: `${P}/x/damaged` })).status).toBe(200)
    expect((await send(found, rec, { id: item, body: { to: 'holder' }, path: `${P}/x/found` })).status).toBe(409)       // damaged is not found
    expect((await send(retire, rec, { id: item, body: { reason: 'Snapped for good' }, path: `${P}/x/retire` })).status).toBe(403)
    expect((await send(retire, aa, { id: item, body: { reason: 'Snapped for good' }, path: `${P}/x/retire` })).status).toBe(200)
  })
})

describe('evidence for lost and damaged keys', () => {
  it('a photo uploaded onto the item is seen by the holder and the staff of the site, not by another resident or another site', async () => {
    const w = await world({ beds: 2 })
    const other = await mkProperty({ beds: 1 })
    const res = await resident(w.bedIds[0])
    const neighbour = await resident(w.bedIds[1])
    const rec = await actor('Rec', { siteIds: [w.siteId] })
    const recOther = await actor('Rec', { siteIds: [other.siteId] })
    const item = await mkItem({ siteId: w.siteId, bedId: w.bedIds[0], holderStaffId: res.staffId })
    const up = await send(upload, rec, { body: { entityType: 'handover_item', entityId: item, filename: 'key.png', contentType: 'image/png', dataBase64: PNG.toString('base64') }, path: '/api/v1/attachments' })
    expect(up.status, JSON.stringify(up.body)).toBe(200)
    const { signIn } = await import('../harness')
    const holder = { user: res.user, cookie: await signIn(res.user) }
    const nb = { user: neighbour.user, cookie: await signIn(neighbour.user) }
    expect((await get(detail, holder, { id: item })).body.data.attachments).toHaveLength(1)
    expect((await get(detail, rec, { id: item })).body.data.attachments).toHaveLength(1)
    expect((await get(detail, nb, { id: item })).status).toBe(404)
    expect((await get(detail, recOther, { id: item })).status).toBe(404)
    // a holder cannot attach to their own record (they cannot hand anything out); another site's staff cannot attach at all
    expect((await send(upload, holder, { body: { entityType: 'handover_item', entityId: item, filename: 'x.png', dataBase64: PNG.toString('base64') }, path: '/api/v1/attachments' })).status).toBe(403)
    expect((await send(upload, recOther, { body: { entityType: 'handover_item', entityId: item, filename: 'x.png', dataBase64: PNG.toString('base64') }, path: '/api/v1/attachments' })).status).toBe(404)
  })
})

describe('keys for a stay, and the keys to swap after a transfer (D-61)', () => {
  it('after a move the keys of the bed they left are listed to return and reissue; the new bed\'s keys are in the cabinet list', async () => {
    const w = await world({ beds: 3 })
    const res = await resident(w.bedIds[1])                                               // now in bed 1 (as after a transfer from bed 0)
    const oldLocker = await mkItem({ siteId: w.siteId, bedId: w.bedIds[0], holderStaffId: res.staffId, itemType: 'locker_key' })
    const oldRoom = await mkRoom(w.siteId)
    const oldRoomKey = await mkItem({ siteId: w.siteId, roomId: oldRoom, holderStaffId: res.staffId })                  // the key of the room they left
    const newLocker = await mkItem({ siteId: w.siteId, bedId: w.bedIds[1], holderStaffId: res.staffId, itemType: 'locker_key' })
    const roomKey = await mkItem({ siteId: w.siteId, roomId: w.roomId, holderStaffId: res.staffId })                  // same room: stays
    const card = await mkItem({ siteId: w.siteId, category: 'asset', itemType: 'access_card', holderStaffId: res.staffId })
    const spare = await mkItem({ siteId: w.siteId, bedId: w.bedIds[1] })                     // in the cabinet for the new bed
    const elsewhere = await mkItem({ siteId: w.siteId, bedId: w.bedIds[2] })
    const rec = await person('Rec', { siteIds: [w.siteId] })

    const swap = await keysToSwapForStay(res.stayId, rec.rc.actor)
    expect(swap.map(r => r.id).sort()).toEqual([oldLocker, oldRoomKey].sort())            // the bed they left and the room they left; not the card, not this room's key
    const k = await keysForStay(rec.rc.actor, res.stayId)
    expect(k).toBeDefined()
    expect(k!.here.map(r => r.id).sort()).toEqual([newLocker, roomKey].sort())
    expect(k!.toSwap.map(r => r.id).sort()).toEqual([oldLocker, oldRoomKey].sort())
    expect(k!.unlinked.map(r => r.id)).toEqual([card])
    expect(k!.available.map(r => r.id)).toEqual([spare])
    expect(k!.available.map(r => r.id)).not.toContain(elsewhere)
    expect(k!.abilities.move).toBe(true)
    // the resident sees their own keys on their stay, but nothing to hand out
    const own = await keysForStay(res.rc.actor, res.stayId)
    expect(own!.here.length + own!.toSwap.length).toBeGreaterThan(0)
    expect(own!.available).toEqual([])
    expect(own!.abilities.move).toBe(false)
    // another site's Reception, and another resident, see nothing
    const strangerRec = await person('Rec', { siteIds: [(await mkProperty({ beds: 1 })).siteId] })
    expect(await keysForStay(strangerRec.rc.actor, res.stayId)).toBeUndefined()
    expect(await keysToSwapForStay(res.stayId, strangerRec.rc.actor)).toEqual([])
    const otherRes = await person('Res')
    expect(await keysForStay(otherRes.rc.actor, res.stayId)).toBeUndefined()
    // and through the route
    const r = await actor('Rec', { siteIds: [w.siteId] })
    const viaRoute = await send(forStay, r, { id: res.stayId, path: `${P}/stays/x` })
    expect(viaRoute.status).toBe(200)
    expect(viaRoute.body.data.toSwap).toHaveLength(2)
    // returning the old locker and issuing the new one completes the swap
    expect((await returnItem(rec.rc, { itemId: oldLocker, onBehalf: undefined, note: 'After the move' })).ok).toBe(true)
    expect((await returnItem(rec.rc, { itemId: oldRoomKey, onBehalf: undefined, note: null })).ok).toBe(true)
    expect((await keysToSwapForStay(res.stayId, rec.rc.actor))).toHaveLength(0)
  })
})

describe('archiving a bed or room is refused while a key is out (extends AT-029)', () => {
  it('issued, lost and damaged items block the archive of their bed and of their room, with owner and next action; returned or retired ones do not', async () => {
    for (const status of ['issued', 'lost', 'damaged'] as const) {
      const w = await world({ beds: 2 })
      const holder = await resident(w.bedIds[1])
      const item = await mkItem({ siteId: w.siteId, bedId: w.bedIds[0], holderStaffId: holder.staffId, status })
      const r = await archiveBed(w.aa.rc, { id: w.bedIds[0], reason: 'Renovation' })
      expect(r.ok, status).toBe(false)
      if (!r.ok) { expect(JSON.stringify(r.detail)).toContain('outstanding_item'); expect(r.owner || r.next).toBeTruthy() }
      const roomItem = await mkItem({ siteId: w.siteId, roomId: w.roomId, holderStaffId: holder.staffId, status })
      const rr = await archiveRoom(w.aa.rc, { id: w.roomId, reason: 'Renovation', cascade: true } as never)
      expect(rr.ok, status).toBe(false)
      if (!rr.ok) expect(JSON.stringify(rr.detail)).toContain('outstanding_item')
      // resolve them: the checks no longer name the items
      for (const id of [item, roomItem]) {
        const res = status === 'issued' ? await returnItem(w.rec.rc, { itemId: id, onBehalf: undefined, note: null }) : await retireItem(w.aa.rc, { itemId: id, reason: 'Written off' })
        expect(res.ok, `${status} ${JSON.stringify(res)}`).toBe(true)
      }
      const after = await archiveBed(w.aa.rc, { id: w.bedIds[0], reason: 'Renovation' })
      expect(JSON.stringify(after.ok ? '' : after.detail)).not.toContain('outstanding_item')
    }
  })
})

void mkStayFor
