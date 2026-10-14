/**
 * WP-I item registry: who may create keys and assets, what is validated (type from configuration, links inside the site, code unique
 * per site and category ignoring capitals), bulk creation with a per-row result, update, archive (never while out), audit.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { admin, closeAll } from '../harness'
import { as, auditsOf, itemRow, mkBed, mkItem, mkProperty, person, resident, world } from './helpers'
import { archiveItem, bulkCreateItems, createItem, updateItem } from '@/server/commands/keys/registry'
import { issueItem, markLost } from '@/server/commands/keys/movements'
import { uniq } from '../harness'

afterAll(closeAll)

const make = (siteId: string, over: Record<string, unknown> = {}) => ({ siteId, category: 'key' as const, itemType: 'room_key', code: uniq('K'), roomId: null, bedId: null, note: null, ...over })

describe('createItem', () => {
  it('Accommodation Admin and Super Admin create items inside their sites; Reception and a Resident cannot', async () => {
    const w = await world()
    const r = await createItem(w.aa.rc, make(w.siteId, { code: 'R1-A', roomId: w.roomId }))
    expect(r.ok, JSON.stringify(r)).toBe(true)
    if (!r.ok) return
    const row = await itemRow(r.data.id)
    expect(row).toMatchObject({ status: 'in_cabinet', holder_staff_id: null, room_id: w.roomId, bed_id: null, item_type: 'room_key' })
    const sa = await person('SA')
    expect((await createItem(sa.rc, make(w.siteId))).ok).toBe(true)
    const rec = await createItem(w.rec.rc, make(w.siteId))
    expect(rec.ok === false && rec.code).toBe('forbidden')
    const res = await person('Res')
    expect((await createItem(res.rc, make(w.siteId))).ok).toBe(false)
  })

  it('an Accommodation Admin of another site reads as "not found"', async () => {
    const w = await world()
    const other = await world()
    const r = await createItem(other.aa.rc, make(w.siteId))
    expect(r.ok === false && r.code).toBe('not_found')
  })

  it('the item type comes from configuration and must match the category (D-72 is open: no hard-coded model)', async () => {
    const w = await world()
    const bad = await createItem(w.aa.rc, make(w.siteId, { itemType: 'jetpack' }))
    expect(bad.ok === false && bad.fields).toMatchObject({ itemType: expect.any(String) })
    const wrongCategory = await createItem(w.aa.rc, make(w.siteId, { category: 'asset', itemType: 'room_key' }))
    expect(wrongCategory.ok).toBe(false)
    const card = await createItem(w.aa.rc, make(w.siteId, { category: 'asset', itemType: 'access_card' }))
    expect(card.ok).toBe(true)
    // A room key and a bed locker key are both items, linked to a room or to a bed.
    const bedId = (await mkProperty({ beds: 1 })).bedIds[0]
    const locker = await createItem(w.aa.rc, make(w.siteId, { itemType: 'locker_key', bedId: w.bedIds[0] }))
    expect(locker.ok).toBe(true)
    void bedId
  })

  it('code is unique per site and category, ignoring capitals and spaces; the same code in another category or site is fine', async () => {
    const w = await world()
    const other = await world()
    expect((await createItem(w.aa.rc, make(w.siteId, { code: 'Key 12' }))).ok).toBe(true)
    const dup = await createItem(w.aa.rc, make(w.siteId, { code: 'KEY 12' }))
    expect(dup.ok === false && dup.code).toBe('conflict')
    expect(dup.ok === false && dup.fields).toMatchObject({ code: expect.any(String) })
    expect(dup.ok === false && dup.next).toBeTruthy()
    expect((await createItem(w.aa.rc, make(w.siteId, { category: 'asset', itemType: 'access_card', code: 'Key 12' }))).ok).toBe(true)
    expect((await createItem(other.aa.rc, make(other.siteId, { code: 'Key 12' }))).ok).toBe(true)
  })

  it('the bed or room must belong to the same site, the bed must be in the chosen room, and archived places are refused', async () => {
    const w = await world()
    const other = await mkProperty({ beds: 1 })
    expect((await createItem(w.aa.rc, make(w.siteId, { bedId: other.bedIds[0] }))).ok).toBe(false)
    expect((await createItem(w.aa.rc, make(w.siteId, { roomId: other.roomId }))).ok).toBe(false)
    const otherRoomBed = (await mkProperty({ beds: 1 }))
    expect((await createItem(w.aa.rc, make(w.siteId, { roomId: w.roomId, bedId: otherRoomBed.bedIds[0] }))).ok).toBe(false)
    const archived = await mkBed(w.roomId, { state: 'archived' })
    const r = await createItem(w.aa.rc, make(w.siteId, { bedId: archived }))
    expect(r.ok === false && r.code).toBe('conflict')
    expect((await createItem(w.aa.rc, make(w.siteId, { roomId: w.roomId, bedId: w.bedIds[0] }))).ok).toBe(true)
  })

  it('writes an audit row with the site', async () => {
    const w = await world()
    const r = await createItem(w.aa.rc, make(w.siteId, { code: 'AUD-1' }))
    if (!r.ok) throw new Error('create failed')
    const a = await auditsOf(r.data.id)
    expect(a).toHaveLength(1)
    expect(a[0]).toMatchObject({ action: 'keys.item.created', actor_role: 'AA', site_id: w.siteId })
    expect(a[0].after).toMatchObject({ code: 'AUD-1', status: 'in_cabinet' })
  })
})

describe('bulkCreateItems', () => {
  it('a prefix and a count give zero-padded codes, one per row', async () => {
    const w = await world()
    const r = await bulkCreateItems(w.aa.rc, { siteId: w.siteId, category: 'key', itemType: 'room_key', roomId: w.roomId, bedId: null, note: null, prefix: 'RM-', count: 3 })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    if (!r.ok) return
    expect(r.data.created).toBe(3)
    expect(r.data.rows.map(x => x.code)).toEqual(['RM-01', 'RM-02', 'RM-03'])
    expect((await admin().query(`SELECT count(*)::int AS n FROM handover_item WHERE site_id = $1`, [w.siteId])).rows[0].n).toBe(3)
  })

  it('a list of codes: each row succeeds or fails on its own (duplicate, invalid), and the answer lists every one', async () => {
    const w = await world()
    await createItem(w.aa.rc, make(w.siteId, { code: 'TAKEN' }))
    const r = await bulkCreateItems(w.aa.rc, { siteId: w.siteId, category: 'key', itemType: 'room_key', roomId: null, bedId: null, note: null, codes: ['NEW-1', 'taken', '###', 'NEW-1', 'NEW-2'] })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    if (!r.ok) return
    expect(r.data.rows.map(x => [x.code, x.ok])).toEqual([['NEW-1', true], ['taken', false], ['###', false], ['NEW-1', false], ['NEW-2', true]])
    expect(r.data).toMatchObject({ created: 2, failed: 3 })
    expect(r.data.rows.filter(x => !x.ok).every(x => !!x.error)).toBe(true)
  })

  it('asks for exactly one way of naming the items and caps the batch', async () => {
    const { bulkInput } = await import('@/server/commands/keys/registry')
    const base = { siteId: crypto.randomUUID(), category: 'key', itemType: 'room_key' }
    expect(bulkInput.safeParse({ ...base }).success).toBe(false)
    expect(bulkInput.safeParse({ ...base, count: 3, codes: ['a'] }).success).toBe(false)
    expect(bulkInput.safeParse({ ...base, count: 201 }).success).toBe(false)
    expect(bulkInput.safeParse({ ...base, prefix: 'A-', count: 5 }).success).toBe(true)
  })

  it('Reception cannot bulk create', async () => {
    const w = await world()
    const r = await bulkCreateItems(w.rec.rc, { siteId: w.siteId, category: 'key', itemType: 'room_key', roomId: null, bedId: null, note: null, count: 2 })
    expect(r.ok).toBe(false)
  })
})

describe('updateItem and archiveItem', () => {
  it('the note and the links can change while the item is in the cabinet, not while it is out', async () => {
    const w = await world()
    const created = await createItem(w.aa.rc, make(w.siteId, { code: 'UPD-1' }))
    if (!created.ok) throw new Error('create failed')
    const u = await updateItem(w.aa.rc, { id: created.data.id, note: 'Spare for room 4', bedId: w.bedIds[0] })
    expect(u.ok, JSON.stringify(u)).toBe(true)
    expect(await itemRow(created.data.id)).toMatchObject({ bed_id: w.bedIds[0] })
    const res = await resident(w.bedIds[0])
    expect((await issueItem(w.rec.rc, { itemId: created.data.id, staffId: res.staffId, dueBack: null, note: null })).ok).toBe(true)
    const locked = await updateItem(w.aa.rc, { id: created.data.id, bedId: w.bedIds[1] })
    expect(locked.ok === false && locked.code).toBe('conflict')
    expect((await updateItem(w.aa.rc, { id: created.data.id, note: 'Still editable' })).ok).toBe(true)
    expect((await auditsOf(created.data.id)).map(a => a.action)).toEqual(['keys.item.created', 'keys.item.updated', 'keys.item.issued', 'keys.item.updated'])
  })

  it('archive frees the code and keeps the history, but is refused while issued, lost or damaged (with owner and next action)', async () => {
    const w = await world()
    const res = await resident(w.bedIds[0])
    const issued = await mkItem({ siteId: w.siteId, bedId: w.bedIds[0], holderStaffId: res.staffId })
    const lost = await mkItem({ siteId: w.siteId, status: 'lost', holderStaffId: res.staffId })
    const damaged = await mkItem({ siteId: w.siteId, status: 'damaged', holderStaffId: res.staffId })
    for (const id of [issued, lost, damaged]) {
      const r = await archiveItem(w.aa.rc, { id, reason: 'Tidy up' })
      expect(r.ok === false && r.code).toBe('conflict')
      expect(r.ok === false && r.owner && r.next).toBeTruthy()
      expect((await itemRow(id)).archived_at).toBeNull()
    }
    const free = await createItem(w.aa.rc, make(w.siteId, { code: 'OLD-1' }))
    if (!free.ok) throw new Error('create failed')
    expect((await archiveItem(w.aa.rc, { id: free.data.id, reason: 'Door replaced' })).ok).toBe(true)
    expect((await itemRow(free.data.id)).archived_at).not.toBeNull()
    expect((await createItem(w.aa.rc, make(w.siteId, { code: 'OLD-1' }))).ok).toBe(true)         // the code is free again
    expect((await auditsOf(free.data.id)).map(a => a.action)).toContain('keys.item.archived')
    expect((await archiveItem(as(w.rec, 'Rec', { siteIds: [w.siteId] }).rc, { id: lost, reason: 'x' })).ok).toBe(false)
  })

  it('a lost item cannot be archived to hide it, and Reception cannot archive', async () => {
    const w = await world()
    const created = await createItem(w.aa.rc, make(w.siteId))
    if (!created.ok) throw new Error('create failed')
    const r = await archiveItem(w.rec.rc, { id: created.data.id, reason: 'no reason' })
    expect(r.ok === false && r.code).toBe('forbidden')
    const res = await resident(w.bedIds[0])
    await issueItem(w.rec.rc, { itemId: created.data.id, staffId: res.staffId, dueBack: null, note: null })
    await markLost(w.rec.rc, { itemId: created.data.id, note: 'Dropped in the sea' })
    expect((await archiveItem(w.aa.rc, { id: created.data.id, reason: 'hide it' })).ok).toBe(false)
  })
})
