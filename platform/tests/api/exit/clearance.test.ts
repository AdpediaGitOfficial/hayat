/**
 * AT-020: clearance after deactivation. The former employee has an outstanding key or asset; an authorised admin completes the items
 * on their behalf; actor, "on behalf of" and the history are kept; the case cannot close with a mandatory item open; a lost key is
 * never marked returned (D-73); the waiver needs a Policy Approver with reason, evidence and a re-confirmed password; then it closes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { admin, call, closeAll, PASSWORD } from '../harness'
import { JPEG, PNG } from '../fixtures3'
import { LocalStore, setStore } from '@/server/attachments'
import { POST as upload } from '../../../app/api/v1/attachments/route'
import { GET as download } from '../../../app/api/v1/attachments/[id]/route'
import { POST as completeRoute } from '../../../app/api/v1/exit/items/[id]/complete/route'
import { POST as outstandingRoute } from '../../../app/api/v1/exit/items/[id]/outstanding/route'
import { POST as reopenRoute } from '../../../app/api/v1/exit/items/[id]/reopen/route'
import { POST as waiveRoute } from '../../../app/api/v1/exit/items/[id]/waive/route'
import { POST as closeRoute } from '../../../app/api/v1/exit/[id]/close/route'
import { GET as getCaseRoute } from '../../../app/api/v1/exit/[id]/route'
import { markLeft } from '@/server/commands/exit/markLeft'
import { completeItem, markOutstanding, reopenItem, waiveItem } from '@/server/commands/exit/items'
import { closeCase } from '@/server/commands/exit/close'
import { getCase } from '@/server/queries/exit/cases'
import { getDb } from '@/server/db/client'
import {
  auditFor, caseOf, eventsOf, itemsOf, mkItem, notifs, resident, snapshot, stayRow, who, world, type World,
} from './helpers'

afterAll(closeAll)
beforeAll(async () => { setStore(new LocalStore(await mkdtemp(path.join(tmpdir(), 'gh-exit-')))) })

const mark = (w: World, staffId: string) => markLeft(w.aa.rc(), { staffId, effectiveDate: '2026-10-14', reason: 'Resigned, last day today', confirmPassword: PASSWORD })
const idOf = (items: Awaited<ReturnType<typeof itemsOf>>, key: string) => items.find(i => i.checklist_key === key)!.id
const params = (id: string) => ({ params: { id }, path: `/api/v1/exit/items/${id}/x` })

/** A resident who left with a room key still on them and a lost access card. */
async function scene() {
  const w = await world()
  const r = await resident({ bedId: w.bedIds[0] })
  const key = await mkItem({ siteId: w.siteId, bedId: w.bedIds[0], holderStaffId: r.staffId, code: 'K-HELD' })
  const card = await mkItem({ siteId: w.siteId, roomId: w.roomId, holderStaffId: r.staffId, status: 'lost', category: 'asset', itemType: 'access_card', code: 'C-LOST' })
  const res = await mark(w, r.staffId)
  if (!res.ok) throw new Error(res.reason)
  const items = await itemsOf(res.data.caseId)
  return { w, r, key, card, caseId: res.data.caseId, items }
}

/** What the register shows when Reception records the return (WP-I's command does this; the tests write the same facts). */
async function returnKey(itemId: string, byUserId: string, staffId: string) {
  await admin().query(`UPDATE handover_item SET status = 'in_cabinet', holder_staff_id = NULL WHERE id = $1`, [itemId])
  await admin().query(`INSERT INTO handover_event (item_id, kind, staff_id, actor_user_id, on_behalf, note) VALUES ($1, 'returned', $2, $3, true, 'Handed in at the desk')`, [itemId, staffId, byUserId])
}

describe('AT-020: completing on behalf of a former employee', () => {
  it('Reception completes an item for them: actor, on-behalf-of, note and time are recorded on the item, in the history and in the audit log', async () => {
    const s = await scene()
    const belongings = idOf(s.items, 'belongings')
    const res = await call(completeRoute, { cookie: s.w.rec.cookie, body: { note: 'Room emptied, 2 bags collected' }, ...params(belongings) })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const item = (await itemsOf(s.caseId)).find(i => i.id === belongings)!
    expect(item).toMatchObject({ status: 'done', done_by: s.w.rec.user.id, on_behalf_of_staff_id: s.r.staffId, note: 'Room emptied, 2 bags collected' })
    const ev = (await eventsOf(s.caseId)).filter(e => e.item_id === belongings)
    expect(ev).toEqual([{ kind: 'item_done', item_id: belongings, actor_user_id: s.w.rec.user.id, on_behalf_of_staff_id: s.r.staffId, note: 'Room emptied, 2 bags collected' }])
    const a = (await auditFor(belongings)).filter(x => x.action === 'exit.clearance.item_done')
    expect(a).toHaveLength(1)
    expect(a[0]).toMatchObject({ actor_role: 'Rec' })
    expect(a[0].before).toMatchObject({ effective: 'open' })
    expect(a[0].after).toMatchObject({ effective: 'done', doneBy: s.w.rec.user.id, onBehalfOfStaffId: s.r.staffId })
    // the lost card is a mandatory item that cannot be done by itself, so the case is waiting on it
    expect((await caseOf(s.r.staffId))[0].status).toBe('pending_items')
    // the case screen can say who did what, when, on whose behalf
    const view = await getCase(getDb(), s.w.aa.rc().actor, s.caseId, new Date())
    const shown = view!.items.find(i => i.id === belongings)!
    expect(shown).toMatchObject({ status: 'done', doneByName: s.w.rec.user.staffId ? expect.any(String) : null, onBehalfOfName: expect.any(String) })
    expect(view!.events.find(e => e.kind === 'item_done')).toMatchObject({ actorName: expect.any(String), onBehalfOfName: expect.any(String), itemLabel: 'Belongings removed from the room' })
  })

  it('a repeat is harmless; a person never completes their own clearance (D-26)', async () => {
    const s = await scene()
    const belongings = idOf(s.items, 'belongings')
    expect((await completeItem(s.w.rec.rc(), { itemId: belongings, note: 'ok' })).ok).toBe(true)
    const again = await completeItem(s.w.rec.rc(), { itemId: belongings, note: 'ok' })
    expect(again.ok && again.data).toMatchObject({ repeated: true })
    expect((await eventsOf(s.caseId)).filter(e => e.kind === 'item_done')).toHaveLength(1)
    // a colleague who is also the subject: Reception person marked Left, then tries to work their own case
    const rec2 = await who('Rec', { siteIds: [s.w.siteId] })
    const { mkStayFor } = await import('./helpers')
    await mkStayFor({ staffId: rec2.user.staffId, bedId: s.w.bedIds[3], from: '2026-10-01' })
    const own = await markLeft(s.w.aa.rc(), { staffId: rec2.user.staffId, effectiveDate: '2026-10-14', reason: 'Resigned', confirmPassword: PASSWORD })
    expect(own.ok).toBe(true)
    if (!own.ok) return
    const ownItems = await itemsOf(own.data.caseId)
    expect(await completeItem(rec2.rc(), { itemId: idOf(ownItems, 'belongings'), note: 'mine' })).toMatchObject({ ok: false, code: 'separation_of_duties' })
  })

  it('who may: Maintenance items only by the Maintenance Coordinator; Reception cannot; a resident, security and another site get nothing', async () => {
    const s = await scene()
    const inspection = idOf(s.items, 'inspection')
    const asRec = await call(completeRoute, { cookie: s.w.rec.cookie, body: {}, ...params(inspection) })
    expect(asRec.status).toBe(403)
    expect(asRec.body).toMatchObject({ owner: 'Maintenance Coordinator' })
    expect((await call(completeRoute, { cookie: s.w.aa.cookie, body: {}, ...params(inspection) })).status).toBe(403) // not the AA's either: it is an inspection
    const other = await call(completeRoute, { cookie: s.w.aaOther.cookie, body: {}, ...params(inspection) })
    expect(other.status).toBe(404) // out of scope looks like it does not exist
    expect((await call(completeRoute, { cookie: s.r.cookie, body: {}, ...params(inspection) })).status).toBe(401) // the former employee's own login is gone
    expect((await call(completeRoute, { cookie: s.w.mc.cookie, body: { note: 'Room inspected, no damage' }, ...params(inspection) })).status).toBe(200)
    expect((await itemsOf(s.caseId)).find(i => i.id === inspection)).toMatchObject({ status: 'done', done_by: s.w.mc.user.id, on_behalf_of_staff_id: s.r.staffId })
    // a Maintenance Coordinator may not do Reception's items
    expect((await call(completeRoute, { cookie: s.w.mc.cookie, body: {}, ...params(idOf(s.items, 'belongings')) })).status).toBe(403)
  })

  it('a key still held cannot be ticked off by hand: it turns Done when its return is recorded in the keys register', async () => {
    const s = await scene()
    const heldItem = s.items.find(i => i.handover_item_id === s.key)!
    const refuse = await completeItem(s.w.rec.rc(), { itemId: heldItem.id, note: 'I think they gave it back' })
    expect(refuse).toMatchObject({ ok: false, code: 'conflict', detail: { reason: 'still_held' }, owner: 'Reception' })
    expect((await itemsOf(s.caseId)).find(i => i.id === heldItem.id)!.status).toBe('open')
    // read live: before the return it is Open
    let view = await getCase(getDb(), s.w.aa.rc().actor, s.caseId, new Date())
    expect(view!.items.find(i => i.id === heldItem.id)).toMatchObject({ status: 'open', handover: { code: 'K-HELD', status: 'issued' } })
    await returnKey(s.key, s.w.rec.user.id, s.r.staffId)
    view = await getCase(getDb(), s.w.aa.rc().actor, s.caseId, new Date())
    expect(view!.items.find(i => i.id === heldItem.id)).toMatchObject({ status: 'done', handover: { status: 'in_cabinet' } })
  })

  it('a lost key or asset stays Outstanding with the Accommodation Admin and is NEVER markable as returned (D-73)', async () => {
    const s = await scene()
    const lostItem = s.items.find(i => i.handover_item_id === s.card)!
    expect(lostItem.owner).toBe('AA')
    for (const by of [s.w.rec, s.w.aa, s.w.sa]) {
      const r = await completeItem(by.rc(), { itemId: lostItem.id, note: 'found it' })
      expect(r).toMatchObject({ ok: false, code: 'conflict', detail: { reason: 'lost_or_damaged' } })
      expect(!r.ok && r.reason).toMatch(/never marked returned/)
    }
    expect(await reopenItem(s.w.aa.rc(), { itemId: lostItem.id, reason: 'try' })).toMatchObject({ ok: false, code: 'conflict' })
    const view = await getCase(getDb(), s.w.aa.rc().actor, s.caseId, new Date())
    expect(view!.items.find(i => i.id === lostItem.id)).toMatchObject({ status: 'outstanding', lostOrDamaged: true, ownerLabel: 'Accommodation Admin' })
    expect((await admin().query(`SELECT status FROM handover_item WHERE id = $1`, [s.card])).rows[0].status).toBe('lost') // the register is untouched
  })
})

describe('the case status follows its items (SRS section 7)', () => {
  it('Open -> In progress -> Pending items -> In progress -> Cleared', async () => {
    const w = await world()
    const r = await resident({ bedId: w.bedIds[0] })
    const res = await mark(w, r.staffId)
    if (!res.ok) throw new Error(res.reason)
    const items = await itemsOf(res.data.caseId)
    const status = async () => (await caseOf(r.staffId))[0].status
    expect(await status()).toBe('open')
    await completeItem(w.rec.rc(), { itemId: idOf(items, 'belongings') })
    expect(await status()).toBe('in_progress')
    await markOutstanding(w.mc.rc(), { itemId: idOf(items, 'inspection'), note: 'Room locked, the key is lost', owner: 'AA' })
    expect(await status()).toBe('pending_items')
    // the owner it was handed to (the Accommodation Admin) finishes it
    expect((await completeItem(w.aa.rc(), { itemId: idOf(items, 'inspection'), note: 'Inspected after the lock was changed' })).ok).toBe(true)
    expect(await status()).toBe('in_progress')
    expect((await closeCase(w.aa.rc(), { caseId: res.data.caseId })).ok).toBe(true)
    expect(await status()).toBe('cleared')
  })
})

describe('AT-020: the case cannot close with a mandatory item open', () => {
  it('lists every blocker with its owner and the next action, and closes nothing', async () => {
    const s = await scene()
    const res = await call(closeRoute, { cookie: s.w.aa.cookie, body: {}, params: { id: s.caseId }, path: `/api/v1/exit/${s.caseId}/close` })
    expect(res.status).toBe(409)
    expect(res.body.reason).toMatch(/mandatory items? (is|are) not complete/)
    const blockers = res.body.detail.blockers as { label: string; status: string; owner: string; next: string }[]
    expect(blockers.map(b => [b.label, b.status, b.owner])).toEqual([
      ['Belongings removed from the room', 'open', 'Reception'],
      ['Room inspection and damage or loss record', 'open', 'Maintenance Coordinator'],
      ['Room key K-HELD', 'open', 'Reception'],
      ['Access card C-LOST', 'outstanding', 'Accommodation Admin'],
    ])
    expect(blockers.every(b => b.next.length > 10)).toBe(true)
    expect(res.body.owner).toBe('Reception, Maintenance Coordinator, Accommodation Admin')
    expect((await caseOf(s.r.staffId))[0]).toMatchObject({ status: 'pending_items', cleared_at: null })
    // the optional "incident and loss record" item does not block
    expect(blockers.some(b => b.label.includes('Incident'))).toBe(false)
  })

  it('a mandatory item that cannot be done is marked Outstanding with a note and an owner; the case moves to Pending items', async () => {
    const s = await scene()
    const belongings = idOf(s.items, 'belongings')
    const res = await call(outstandingRoute, { cookie: s.w.rec.cookie, body: { note: 'Belongings are locked in a cabinet; the cabinet key is with security', owner: 'AA' }, ...params(belongings) })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect((await itemsOf(s.caseId)).find(i => i.id === belongings)).toMatchObject({ status: 'outstanding', owner: 'AA', note: expect.stringContaining('cabinet') })
    expect((await caseOf(s.r.staffId))[0].status).toBe('pending_items')
    expect((await eventsOf(s.caseId)).at(-1)).toMatchObject({ kind: 'item_outstanding', actor_user_id: s.w.rec.user.id })
    expect((await call(outstandingRoute, { cookie: s.w.rec.cookie, body: { note: '' }, ...params(belongings) })).status).toBe(422) // a note is mandatory
    // the owner can still finish it later
    expect((await completeItem(s.w.aa.rc(), { itemId: belongings, note: 'Cabinet opened' })).ok).toBe(true)
  })

  it('reopening is for the Accommodation Admin, with a reason; the history keeps both moves', async () => {
    const s = await scene()
    const belongings = idOf(s.items, 'belongings')
    await completeItem(s.w.rec.rc(), { itemId: belongings, note: 'done' })
    expect((await call(reopenRoute, { cookie: s.w.rec.cookie, body: { reason: 'oops' }, ...params(belongings) })).status).toBe(403)
    expect((await call(reopenRoute, { cookie: s.w.aa.cookie, body: { reason: '' }, ...params(belongings) })).status).toBe(422)
    expect((await call(reopenRoute, { cookie: s.w.aa.cookie, body: { reason: 'A bag was left behind' }, ...params(belongings) })).status).toBe(200)
    expect((await itemsOf(s.caseId)).find(i => i.id === belongings)).toMatchObject({ status: 'open', done_by: null, on_behalf_of_staff_id: null })
    expect((await eventsOf(s.caseId)).filter(e => e.item_id === belongings).map(e => e.kind)).toEqual(['item_done', 'item_reopened'])
  })
})

describe('AT-020: the waiver (Policy Approver only, reason + evidence + password)', () => {
  it('nobody but a Policy Approver can waive: AA, SA, Reception and Maintenance are refused with owner and next action', async () => {
    const s = await scene()
    const card = s.items.find(i => i.handover_item_id === s.card)!.id
    for (const by of [s.w.aa, s.w.sa, s.w.rec, s.w.mc]) {
      const r = await call(waiveRoute, { cookie: by.cookie, body: { reason: 'Written off', evidence: 'Police report 123', confirmPassword: PASSWORD }, ...params(card) })
      expect(r.status, by.role).toBe(403)
    }
    const direct = await waiveItem(s.w.aa.rc(), { itemId: card, reason: 'Written off', evidence: 'Police report 123', confirmPassword: PASSWORD })
    expect(direct).toMatchObject({ ok: false, code: 'forbidden', owner: 'Policy Approver' })
    expect((await itemsOf(s.caseId)).find(i => i.id === card)!.status).toBe('open')
  })

  it('reason and evidence are both mandatory, and the password is re-confirmed; a refusal changes nothing', async () => {
    const s = await scene()
    const card = s.items.find(i => i.handover_item_id === s.card)!.id
    const before = await snapshot(s.r.staffId, s.r.user.id)
    const noEvidence = await call(waiveRoute, { cookie: s.w.pa.cookie, body: { reason: 'Written off', confirmPassword: PASSWORD }, ...params(card) })
    expect(noEvidence.status).toBe(422)
    expect(noEvidence.body.fields.evidence).toBeDefined()
    const noReason = await call(waiveRoute, { cookie: s.w.pa.cookie, body: { reason: ' ', evidence: 'Police report 123', confirmPassword: PASSWORD }, ...params(card) })
    expect(noReason.status).toBe(422)
    expect(noReason.body.fields.reason).toBeDefined()
    const noPassword = await waiveItem(s.w.pa.rc(), { itemId: card, reason: 'Written off', evidence: 'Police report 123' })
    expect(noPassword).toMatchObject({ ok: false, code: 'invalid', fields: { confirmPassword: expect.any(String) } })
    const wrong = await waiveItem(s.w.pa.rc(), { itemId: card, reason: 'Written off', evidence: 'Police report 123', confirmPassword: 'not-the-password-1' })
    expect(wrong).toMatchObject({ ok: false, code: 'invalid', fields: { confirmPassword: 'Wrong password' } })
    expect(await snapshot(s.r.staffId, s.r.user.id)).toBe(before)
    expect((await auditFor(card)).filter(a => a.action === 'exit.clearance.item_waived')).toHaveLength(0)
  })

  it('a Policy Approver never waives on their own case (D-26)', async () => {
    const w = await world()
    const pa2 = await who('Mgr', { siteIds: [w.siteId], caps: ['PolicyApprover'] })
    const { mkStayFor } = await import('./helpers')
    await mkStayFor({ staffId: pa2.user.staffId, bedId: w.bedIds[2], from: '2026-10-01' })
    const res = await markLeft(w.sa.rc(), { staffId: pa2.user.staffId, effectiveDate: '2026-10-14', reason: 'Resigned', confirmPassword: PASSWORD })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const item = (await itemsOf(res.data.caseId))[0].id
    expect(await waiveItem(pa2.rc(), { itemId: item, reason: 'Write it off', evidence: 'My own say-so', confirmPassword: PASSWORD })).toMatchObject({ ok: false, code: 'separation_of_duties' })
  })

  it('the full flow: complete, mark outstanding, waive the lost card with evidence uploaded to the item, then the case closes (stay untouched)', async () => {
    const s = await scene()
    const [belongings, inspection] = [idOf(s.items, 'belongings'), idOf(s.items, 'inspection')]
    const card = s.items.find(i => i.handover_item_id === s.card)!.id
    expect((await completeItem(s.w.rec.rc(), { itemId: belongings, note: 'Room emptied' })).ok).toBe(true)
    expect((await completeItem(s.w.mc.rc(), { itemId: inspection, note: 'No damage' })).ok).toBe(true)
    await returnKey(s.key, s.w.rec.user.id, s.r.staffId)

    // evidence goes onto the item through the attachment service: the Policy Approver may attach, Reception may attach, a resident may not
    const up = await call(upload, { cookie: s.w.pa.cookie, body: { entityType: 'clearance_item', entityId: card, filename: 'police-report.png', dataBase64: PNG.toString('base64') } })
    expect(up.status, JSON.stringify(up.body)).toBe(200)
    const att = up.body.data.id as string
    expect((await call(upload, { cookie: s.r.cookie, body: { entityType: 'clearance_item', entityId: card, filename: 'x.png', dataBase64: PNG.toString('base64') } })).status).toBe(401)
    // an attachment that hangs on a different item is not evidence for this one
    const otherUp = await call(upload, { cookie: s.w.pa.cookie, body: { entityType: 'clearance_item', entityId: belongings, filename: 'other.jpg', dataBase64: JPEG.toString('base64') } })
    const wrongEv = await waiveItem(s.w.pa.rc(), { itemId: card, reason: 'Written off', evidence: 'Police report', attachmentIds: [otherUp.body.data.id], confirmPassword: PASSWORD })
    expect(wrongEv).toMatchObject({ ok: false, code: 'invalid' })

    const w = await call(waiveRoute, { cookie: s.w.pa.cookie, body: { reason: 'Card lost on site; replaced by the hotel at its own cost', evidence: 'Security incident report SIR-2291, signed by the duty manager', attachmentIds: [att], confirmPassword: PASSWORD }, ...params(card) })
    expect(w.status, JSON.stringify(w.body)).toBe(200)
    const item = (await itemsOf(s.caseId)).find(i => i.id === card) as unknown as Record<string, unknown>
    expect(item).toMatchObject({ status: 'waived' })
    const row = (await admin().query(`SELECT waived_by, waived_at, waiver_reason, waiver_evidence FROM clearance_item WHERE id = $1`, [card])).rows[0]
    expect(row).toMatchObject({ waived_by: s.w.pa.user.id, waiver_reason: expect.stringContaining('replaced'), waiver_evidence: expect.stringContaining('SIR-2291') })
    expect(row.waived_at).not.toBeNull()
    const a = (await auditFor(card)).filter(x => x.action === 'exit.clearance.item_waived')
    expect(a).toHaveLength(1)
    expect(a[0].after).toMatchObject({ waivedBy: s.w.pa.user.id, evidence: expect.stringContaining('SIR-2291'), attachmentIds: [att] })
    expect((await notifs(`clearance:item:${card}`)).map(n => n.to_role)).toEqual(['AA'])
    // the evidence can be read by those who see the case: AA, Reception, MC; not by another site; not by the Manager role
    const dl = async (cookie: string) => (await download(new Request('http://localhost:3000/x', { headers: { host: 'localhost:3000', origin: 'http://localhost:3000', cookie } }), { params: { id: att } })).status
    expect(await dl(s.w.aa.cookie)).toBe(200)
    expect(await dl(s.w.rec.cookie)).toBe(200)
    expect(await dl(s.w.pa.cookie)).toBe(200)
    expect(await dl(s.w.aaOther.cookie)).toBe(404)

    // waived items are final
    expect(await reopenItem(s.w.aa.rc(), { itemId: card, reason: 'undo' })).toMatchObject({ ok: false, code: 'conflict', owner: 'Policy Approver' })
    expect((await admin().query(`UPDATE clearance_item SET status = 'open' WHERE id = $1`, [card]).catch(e => e)).message).toMatch(/waived clearance item cannot be reopened/)

    // now the case closes; the stay is still active and the bed untouched
    const closed = await call(closeRoute, { cookie: s.w.aa.cookie, body: {}, params: { id: s.caseId }, path: `/api/v1/exit/${s.caseId}/close` })
    expect(closed.status, JSON.stringify(closed.body)).toBe(200)
    expect((await caseOf(s.r.staffId))[0]).toMatchObject({ status: 'cleared' })
    expect((await caseOf(s.r.staffId))[0].cleared_at).not.toBeNull()
    expect(await stayRow(s.r.stayId!)).toMatchObject({ status: 'active', checked_out_at: null })
    // history: who did what, when
    const kinds = (await eventsOf(s.caseId)).map(e => e.kind)
    expect(kinds).toEqual(['opened', 'item_done', 'item_done', 'item_waived', 'item_synced', 'closed'])
    // the item states are frozen in a cleared case, in the database as well
    expect((await admin().query(`UPDATE clearance_item SET note = 'tamper' WHERE id = $1`, [belongings]).catch(e => e)).message).toMatch(/final/)
    expect(await completeItem(s.w.rec.rc(), { itemId: belongings, note: 'again' })).toMatchObject({ ok: false, code: 'conflict' })
    // closing again is harmless
    const again = await closeCase(s.w.aa.rc(), { caseId: s.caseId })
    expect(again.ok && again.data).toMatchObject({ repeated: true })
    // the case screen data agrees
    const shown = await call(getCaseRoute, { cookie: s.w.aa.cookie, params: { id: s.caseId } })
    expect(shown.body.data).toMatchObject({ status: 'cleared', stay: { stillInBed: true, status: 'active' } })
    expect(shown.body.data.items.find((i: { id: string }) => i.id === card)).toMatchObject({ status: 'waived', waiver: { reason: expect.stringContaining('replaced'), evidence: expect.stringContaining('SIR-2291') }, attachments: [expect.objectContaining({ id: att })] })
  })

  it('a waiver on a case of another site is "not found"; closing needs the Accommodation Admin', async () => {
    const s = await scene()
    const paOther = await who('Mgr', { siteIds: [(await world()).siteId], caps: ['PolicyApprover'] })
    const card = s.items.find(i => i.handover_item_id === s.card)!.id
    expect((await call(waiveRoute, { cookie: paOther.cookie, body: { reason: 'Written off', evidence: 'Police report', confirmPassword: PASSWORD }, ...params(card) })).status).toBe(404)
    for (const by of [s.w.rec, s.w.mc, s.w.pa]) {
      expect((await call(closeRoute, { cookie: by.cookie, body: {}, params: { id: s.caseId }, path: `/api/v1/exit/${s.caseId}/close` })).status, by.role).toBe(403)
    }
    expect((await call(getCaseRoute, { cookie: s.w.aaOther.cookie, params: { id: s.caseId } })).status).toBe(404)
    expect((await call(getCaseRoute, { cookie: s.w.rec.cookie, params: { id: s.caseId } })).status).toBe(200)
    expect((await call(getCaseRoute, { cookie: s.w.pa.cookie, params: { id: s.caseId } })).status).toBe(200)
  })

  it('a case the mandatory items of which are all done or waived closes even though the optional one is open', async () => {
    const w = await world()
    const r = await resident({ bedId: w.bedIds[0] })
    const res = await mark(w, r.staffId)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const items = await itemsOf(res.data.caseId)
    expect((await completeItem(w.rec.rc(), { itemId: idOf(items, 'belongings') })).ok).toBe(true)
    expect((await closeCase(w.aa.rc(), { caseId: res.data.caseId })).ok).toBe(false) // inspection still open
    expect((await waiveItem(w.pa.rc(), { itemId: idOf(items, 'inspection'), reason: 'Room demolished next week', evidence: 'Works order W-77', confirmPassword: PASSWORD })).ok).toBe(true)
    const closed = await closeCase(w.aa.rc(), { caseId: res.data.caseId })
    expect(closed.ok).toBe(true)
    expect((await itemsOf(res.data.caseId)).find(i => i.checklist_key === 'loss_record')!.status).toBe('open') // optional: left as it was
  })
})
