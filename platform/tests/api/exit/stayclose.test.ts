/**
 * Checkout is not clearance and not bed ready (D-64). A stay becomes `closed` only when it is checked out AND its clearance case is
 * Cleared AND nothing is held against it (src/server/stays-close.ts, with this package's closer). Whichever finishes last closes it.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { admin, closeAll, PASSWORD } from '../harness'
import { markLeft } from '@/server/commands/exit/markLeft'
import { completeItem, waiveItem } from '@/server/commands/exit/items'
import { closeCase } from '@/server/commands/exit/close'
import { processCheckout } from '@/server/commands/stays/checkout'
import { registerStayCloser, closeStayIfDone } from '@/server/stays-close'
import { getDb } from '@/server/db/client'
import { mkItem, resident, stayRow, world, itemsOf, type World } from './helpers'

afterAll(closeAll)

const idOf = (items: Awaited<ReturnType<typeof itemsOf>>, key: string) => items.find(i => i.checklist_key === key)!.id
async function mark(w: World, staffId: string) {
  const r = await markLeft(w.aa.rc(), { staffId, effectiveDate: '2026-10-14', reason: 'Resigned', confirmPassword: PASSWORD })
  if (!r.ok) throw new Error(r.reason)
  return r.data.caseId
}
/** Everything mandatory done, then the case closed. Returns the close result. */
async function clearAll(w: World, caseId: string) {
  const items = await itemsOf(caseId)
  await completeItem(w.rec.rc(), { itemId: idOf(items, 'belongings') })
  await completeItem(w.mc.rc(), { itemId: idOf(items, 'inspection') })
  return closeCase(w.aa.rc(), { caseId })
}
const checkout = (w: World, stayId: string) => processCheckout(w.rec.rc(), { stayId, note: null })

describe('when does a stay close?', () => {
  it('a voluntary checkout has no clearance case: the stay stays checked_out, nothing pretends a clearance happened', async () => {
    const w = await world()
    const r = await resident({ bedId: w.bedIds[0] })
    expect((await checkout(w, r.stayId!)).ok).toBe(true)
    expect(await stayRow(r.stayId!)).toMatchObject({ status: 'checked_out', closed_at: null })
  })

  it('exit first, then checkout, then the case clears: the stay closes when the case clears (the last thing)', async () => {
    const w = await world()
    const r = await resident({ bedId: w.bedIds[0] })
    const caseId = await mark(w, r.staffId)
    expect(await stayRow(r.stayId!)).toMatchObject({ status: 'active' })
    expect((await checkout(w, r.stayId!)).ok).toBe(true)
    expect(await stayRow(r.stayId!)).toMatchObject({ status: 'checked_out', closed_at: null }) // checked out, not cleared
    const closed = await clearAll(w, caseId)
    expect(closed.ok && closed.data.staysClosed).toEqual([r.stayId])
    const s = await stayRow(r.stayId!)
    expect(s.status).toBe('closed')
    expect(s.closed_at).not.toBeNull()
  })

  it('clearance first, then checkout: checkout itself closes the stay (it calls closeStayIfDone), and the bed still needs cleaning', async () => {
    const w = await world()
    const r = await resident({ bedId: w.bedIds[0] })
    const caseId = await mark(w, r.staffId)
    const closed = await clearAll(w, caseId)
    expect(closed.ok && closed.data.staysClosed).toEqual([]) // still in the bed: nothing to close yet
    expect(await stayRow(r.stayId!)).toMatchObject({ status: 'active' })
    expect((await checkout(w, r.stayId!)).ok).toBe(true)
    expect(await stayRow(r.stayId!)).toMatchObject({ status: 'closed' })
    expect((await admin().query(`SELECT state FROM bed WHERE id = $1`, [w.bedIds[0]])).rows[0].state).toBe('needs_cleaning') // clearance complete != bed ready
  })

  it('a key still held blocks it, until the return is recorded; then the last thing to finish closes it', async () => {
    const w = await world()
    const r = await resident({ bedId: w.bedIds[0] })
    const key = await mkItem({ siteId: w.siteId, bedId: w.bedIds[0], holderStaffId: r.staffId, code: 'K-STAY' })
    const caseId = await mark(w, r.staffId)
    await checkout(w, r.stayId!)
    // case cannot close with the key held
    expect((await clearAll(w, caseId)).ok).toBe(false)
    expect(await stayRow(r.stayId!)).toMatchObject({ status: 'checked_out' })
    // Reception records the return (WP-I's command does this; the same facts), then the case clears and the stay closes with it
    await admin().query(`UPDATE handover_item SET status = 'in_cabinet', holder_staff_id = NULL WHERE id = $1`, [key])
    await admin().query(`INSERT INTO handover_event (item_id, kind, staff_id, actor_user_id, on_behalf, note) VALUES ($1, 'returned', $2, $3, true, 'Handed in')`, [key, r.staffId, w.rec.user.id])
    const closed = await closeCase(w.aa.rc(), { caseId })
    expect(closed.ok && closed.data.staysClosed).toEqual([r.stayId])
    expect(await stayRow(r.stayId!)).toMatchObject({ status: 'closed' })
    // the key item was written down as Done on the person's behalf, attributed to whoever recorded the return
    const item = (await itemsOf(caseId)).find(i => i.handover_item_id === key)!
    expect(item).toMatchObject({ status: 'done', done_by: w.rec.user.id, on_behalf_of_staff_id: r.staffId })
  })

  it('a stay checked out BEFORE the exit is closed by the clearance too, once nothing is held', async () => {
    const w = await world()
    const r = await resident({ bedId: w.bedIds[0] })
    await checkout(w, r.stayId!) // voluntary: no case
    expect(await stayRow(r.stayId!)).toMatchObject({ status: 'checked_out' })
    const caseId = await mark(w, r.staffId)
    const items = await itemsOf(caseId)
    expect((await getDb().transaction(tx => closeStayIfDone(tx, r.stayId!, new Date()))).valueOf()).toBe(false) // the case is open: not cleared
    await completeItem(w.rec.rc(), { itemId: idOf(items, 'belongings') })
    await waiveItem(w.pa.rc(), { itemId: idOf(items, 'inspection'), reason: 'Refurbished', evidence: 'Works order', confirmPassword: PASSWORD })
    const closed = await closeCase(w.aa.rc(), { caseId })
    expect(closed.ok && closed.data.staysClosed).toEqual([r.stayId])
  })

  it('an old cleared case does not close a later stay of the same person (rehire, new stay, checkout)', async () => {
    const w = await world()
    const r = await resident({ bedId: w.bedIds[0] })
    const caseId = await mark(w, r.staffId)
    await checkout(w, r.stayId!)
    await clearAll(w, caseId)
    expect(await stayRow(r.stayId!)).toMatchObject({ status: 'closed' })
    // the person returns: same profile, a new stay that starts after the old case opened
    await admin().query(`UPDATE staff_profile SET employment_status = 'active', left_at = NULL, left_effective = NULL WHERE id = $1`, [r.staffId])
    const { mkStayFor } = await import('./helpers')
    const s2 = await mkStayFor({ staffId: r.staffId, bedId: w.bedIds[1], from: '2026-11-01' })
    await admin().query(`UPDATE stay SET checked_in_at = '2026-11-01T10:00:00Z' WHERE id = $1`, [s2.stayId])
    expect((await checkout(w, s2.stayId)).ok).toBe(true)
    expect(await stayRow(s2.stayId)).toMatchObject({ status: 'checked_out', closed_at: null }) // the old case belongs to the old stay
  })

  it('the clearance closer is registered in stays-close (registering it again is a no-op)', async () => {
    const { clearanceCloser } = await import('@/server/commands/exit/closer')
    registerStayCloser('clearance', async () => false) // same id: ignored
    const w = await world()
    const r = await resident({ bedId: w.bedIds[0] })
    const caseId = await mark(w, r.staffId)
    await checkout(w, r.stayId!)
    await clearAll(w, caseId)
    expect(await stayRow(r.stayId!)).toMatchObject({ status: 'closed' })
    expect(typeof clearanceCloser).toBe('function')
  })
})

describe('a waived lost key (seam documented for the merge)', () => {
  it('closes the case, but the register still shows the key held by the person, so the stay stays checked_out until the item is resolved in Keys & assets', async () => {
    const w = await world()
    const r = await resident({ bedId: w.bedIds[0] })
    const card = await mkItem({ siteId: w.siteId, roomId: w.roomId, holderStaffId: r.staffId, status: 'lost', category: 'asset', itemType: 'access_card', code: 'C-WAIVED' })
    const caseId = await mark(w, r.staffId)
    await checkout(w, r.stayId!)
    const items = await itemsOf(caseId)
    await completeItem(w.rec.rc(), { itemId: idOf(items, 'belongings') })
    await completeItem(w.mc.rc(), { itemId: idOf(items, 'inspection') })
    await waiveItem(w.pa.rc(), { itemId: items.find(i => i.handover_item_id === card)!.id, reason: 'Lost on site', evidence: 'Incident SIR-1', confirmPassword: PASSWORD })
    expect((await closeCase(w.aa.rc(), { caseId })).ok).toBe(true)
    expect(await stayRow(r.stayId!)).toMatchObject({ status: 'checked_out' }) // the WP-0 handover blocker still sees the lost card
    // once WP-I retires or resolves the card, the next closeStayIfDone call (a return, a recheck) closes it
    await admin().query(`UPDATE handover_item SET status = 'retired', holder_staff_id = NULL WHERE id = $1`, [card])
    expect(await getDb().transaction(tx => closeStayIfDone(tx, r.stayId!, new Date()))).toBe(true)
  })
})
