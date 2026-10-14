/**
 * AT-035 (P-06) and AT-019 / AT-020 (P-07, P-08): the PROPOSED clearance and exit rules, each in BOTH states. Every one is pending client
 * sign-off and sits behind a setting:
 *   clearance.waiver_writes_off_key  (P-06, ships ON  = the Stage 3 behaviour)
 *   clearance.strict_item_owners     (P-07, ships OFF = Reception may also complete Accommodation Admin items)
 *   exit.sited_only                  (P-08, ships OFF = any holder of the action)
 * Runs in a private database: these are GLOBAL settings, and the shared test database is used by every test file at once.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { createIsolated, PASSWORD } from '../access/isolated'
import { isoWorld, uniq, type IsoPerson } from '../keys/iso-world'
import { markLeft } from '@/server/commands/exit/markLeft'
import { closeCase } from '@/server/commands/exit/close'
import { completeItem, markOutstanding, reopenItem, waiveItem } from '@/server/commands/exit/items'
import { confirmBulkExit, previewBulkExit } from '@/server/commands/exit/bulk'
import { replaceItem, retireItem } from '@/server/commands/keys/movements'
import { getCase } from '@/server/queries/exit/cases'
import { findForExit } from '@/server/queries/exit/find'
import { CONFIG, getConfig } from '@/server/config/registry'
import { getDb } from '@/server/db/client'

const iso = await createIsolated()
afterAll(async () => {
  // pg-pool's end() resolves before the sockets are closed, and close() then drops the database WITH (FORCE): wait for the sockets first.
  const end = iso.admin.end.bind(iso.admin)
  iso.admin.end = (async () => { await end(); await new Promise(r => setTimeout(r, 250)) }) as typeof iso.admin.end
  await iso.close()
})
const w = isoWorld(iso)

async function withSetting<T>(key: keyof typeof CONFIG, value: unknown, fn: () => Promise<T>): Promise<T> {
  await w.setConfig(key, value)
  try { return await fn() } finally { await w.setConfig(key, CONFIG[key].default) }
}

async function cast(o: { beds?: number } = {}) {
  const p = await w.mkProperty({ beds: o.beds ?? 3 })
  const aa = await w.person('AA', { siteIds: [p.siteId] })
  const rec = await w.person('Rec', { siteIds: [p.siteId] })
  const mc = await w.person('MC', { siteIds: [p.siteId] })
  const pa = await w.person('Mgr', { siteIds: [p.siteId], caps: ['PolicyApprover'] })
  const sa = await w.person('SA')
  return { ...p, aa, rec, mc, pa, sa }
}
type Cast = Awaited<ReturnType<typeof cast>>

/** A resident with a login and a stay in bed 0 who is then marked Left by the Accommodation Admin. */
async function leaver(c: Cast, o: { bed?: number; items?: { status: 'issued' | 'lost' | 'damaged'; code?: string }[] } = {}) {
  const res = await w.person('Res')
  const stay = await w.mkStay({ staffId: res.staffId, bedId: c.bedIds[o.bed ?? 0] })
  const keys: string[] = []
  for (const it of o.items ?? []) keys.push(await w.mkItem({ siteId: c.siteId, bedId: c.bedIds[o.bed ?? 0], holderStaffId: res.staffId, status: it.status, code: it.code ?? uniq('K') }))
  const r = await markLeft(c.aa.rc, { staffId: res.staffId, effectiveDate: '2026-10-14', reason: 'Resigned', confirmPassword: PASSWORD })
  if (!r.ok) throw new Error(r.reason)
  const items = (await w.q<{ id: string; kind: string; checklist_key: string | null; handover_item_id: string | null; status: string; owner: string }>(
    `SELECT id, kind, checklist_key, handover_item_id, status, owner FROM clearance_item WHERE case_id = $1 ORDER BY position`, [r.data.caseId])).rows
  const byKey = (k: string) => items.find(i => i.checklist_key === k)!.id
  const byHandover = (itemId: string) => items.find(i => i.handover_item_id === itemId)!.id
  return { res, stay, keys, caseId: r.data.caseId, items, byKey, byHandover }
}

const checkOut = (stayId: string) => w.q(`UPDATE stay SET status = 'checked_out', checked_out_at = '2026-10-14T09:00:00Z' WHERE id = $1`, [stayId])
const checklistDone = (caseId: string) => w.q(`UPDATE clearance_item SET status = 'done', done_at = now() WHERE case_id = $1 AND kind = 'checklist'`, [caseId])
const waive = (c: Cast, itemId: string) => waiveItem(c.pa.rc, { itemId, reason: 'Lost, will not be recovered', evidence: 'Incident report 114', confirmPassword: PASSWORD })

describe('shipped defaults (each is pending client sign-off and ships as written)', () => {
  it('P-06 ON, P-07 OFF, P-08 OFF, each marked as a proposal', async () => {
    const db = getDb()
    expect(await getConfig(db, 'clearance.waiver_writes_off_key')).toBe(true)
    expect(await getConfig(db, 'clearance.strict_item_owners')).toBe(false)
    expect(await getConfig(db, 'exit.sited_only')).toBe(false)
    expect(CONFIG['clearance.waiver_writes_off_key'].proposed).toBe('P-06')
    expect(CONFIG['clearance.strict_item_owners'].proposed).toBe('P-07')
    expect(CONFIG['exit.sited_only'].proposed).toBe('P-08')
  })
})

describe('AT-035 / AT-020 P-06: a waiver of a lost key', () => {
  it('ON (the default): the key is written off (retired, history kept) and the stay closes', async () => {
    const c = await cast()
    const l = await leaver(c, { items: [{ status: 'lost', code: 'LOST-ON' }] })
    await checkOut(l.stay.stayId)
    await checklistDone(l.caseId)
    expect((await waive(c, l.byHandover(l.keys[0]))).ok).toBe(true)
    expect(await w.itemRow(l.keys[0])).toMatchObject({ status: 'retired', holder_staff_id: null })
    const ev = await w.events(l.keys[0])
    expect(ev.at(-1)).toMatchObject({ kind: 'retired', staff_id: l.res.staffId, on_behalf: true, note: expect.stringContaining('Written off by a Policy Approver waiver') })
    expect((await w.audits(l.keys[0])).map(a => a.action)).toContain('keys.item.written_off')
    const view = await getCase(getDb(), c.aa.rc.actor, l.caseId, new Date())
    expect(view!.rules.waiverWritesOffKey).toBe(true)
    expect(view!.items.find(i => i.id === l.byHandover(l.keys[0]))!.keyOpenAfterWaiver).toBeNull()
    const closed = await closeCase(c.aa.rc, { caseId: l.caseId })
    expect(closed.ok && closed.data.staysClosed).toEqual([l.stay.stayId])
    expect((await w.stayStatus(l.stay.stayId)).status).toBe('closed')
  })

  it('OFF: the waiver is recorded but the key stays Lost, the stay stays checked out; the case says so with owner and next action; Keys & assets resolves it (retire)', async () => {
    await withSetting('clearance.waiver_writes_off_key', false, async () => {
      const c = await cast()
      const l = await leaver(c, { items: [{ status: 'lost', code: 'LOST-OFF' }] })
      await checkOut(l.stay.stayId)
      await checklistDone(l.caseId)
      const itemId = l.byHandover(l.keys[0])
      expect((await waive(c, itemId)).ok).toBe(true)
      // the waiver is on the case ...
      const stored = (await w.q<{ status: string; waived_by: string | null }>(`SELECT status, waived_by FROM clearance_item WHERE id = $1`, [itemId])).rows[0]
      expect(stored).toMatchObject({ status: 'waived', waived_by: c.pa.userId })
      // ... but the key is untouched: still Lost, still the holder's, no event, no write-off audit
      expect(await w.itemRow(l.keys[0])).toMatchObject({ status: 'lost', holder_staff_id: l.res.staffId })
      expect(await w.events(l.keys[0])).toHaveLength(0)
      expect((await w.audits(l.keys[0])).map(a => a.action)).not.toContain('keys.item.written_off')
      const waivedAudit = (await w.audits(itemId)).find(a => a.action === 'exit.clearance.item_waived')!
      expect(waivedAudit.after).toMatchObject({ keyWrittenOff: false, keyStaysOpen: { code: 'LOST-OFF', status: 'lost' } })
      // the Accommodation Admin is told the key is still open
      expect((await w.notesAbout(l.keys[0])).map(n => [n.kind, n.to_role])).toEqual([['exit.waived_key_open', 'AA']])
      // the case screen says so: owner and next action
      const view = await getCase(getDb(), c.aa.rc.actor, l.caseId, new Date())
      expect(view!.rules.waiverWritesOffKey).toBe(false)
      expect(view!.items.find(i => i.id === itemId)!.keyOpenAfterWaiver).toEqual({
        code: 'LOST-OFF', status: 'lost', owner: 'Accommodation Admin', next: expect.stringMatching(/Retire or replace LOST-OFF in Keys & assets.*stay stays open/),
      })
      // the case itself can be cleared (the waiver is accepted) but the stay is held by the key
      const closed = await closeCase(c.aa.rc, { caseId: l.caseId })
      expect(closed.ok, JSON.stringify(closed)).toBe(true)
      expect(closed.ok && closed.data.staysClosed).toEqual([])
      expect((await w.stayStatus(l.stay.stayId)).status).toBe('checked_out')
      // Keys & assets resolves it: retire, and the stay closes
      const r = await retireItem(c.aa.rc, { itemId: l.keys[0], reason: 'Written off after the waiver' })
      expect(r.ok && r.data.closedStays).toEqual([l.stay.stayId])
      expect((await w.stayStatus(l.stay.stayId)).status).toBe('closed')
      expect(await w.itemRow(l.keys[0])).toMatchObject({ status: 'retired', holder_staff_id: null })
    })
  })

  it('OFF: replacing the key resolves it too, and a damaged or still-issued key behaves the same', async () => {
    await withSetting('clearance.waiver_writes_off_key', false, async () => {
      const c = await cast()
      const l = await leaver(c, { items: [{ status: 'damaged' }, { status: 'issued' }] })
      await checkOut(l.stay.stayId)
      await checklistDone(l.caseId)
      expect((await waive(c, l.byHandover(l.keys[0]))).ok).toBe(true)
      expect((await waive(c, l.byHandover(l.keys[1]))).ok).toBe(true)
      expect(await w.itemRow(l.keys[0])).toMatchObject({ status: 'damaged', holder_staff_id: l.res.staffId })
      expect(await w.itemRow(l.keys[1])).toMatchObject({ status: 'issued', holder_staff_id: l.res.staffId })
      expect((await closeCase(c.aa.rc, { caseId: l.caseId })).ok).toBe(true)
      expect((await w.stayStatus(l.stay.stayId)).status).toBe('checked_out')
      // replacing the damaged one retires it and gives the (departed) holder no new key: still held by the issued one
      const rep = await replaceItem(c.aa.rc, { itemId: l.keys[0], newCode: uniq('NEW'), note: null })
      expect(rep.ok && rep.data.closedStays).toEqual([])
      expect((await w.stayStatus(l.stay.stayId)).status).toBe('checked_out')
      // the issued one is returned at the desk and the stay closes
      const { returnItem } = await import('@/server/commands/keys/movements')
      const back = await returnItem(c.rec.rc, { itemId: l.keys[1], note: null })
      expect(back.ok && back.data.closedStays).toEqual([l.stay.stayId])
    })
  })

  it('a waiver of an ordinary checklist item is not affected by the setting', async () => {
    for (const on of [true, false]) {
      await withSetting('clearance.waiver_writes_off_key', on, async () => {
        const c = await cast()
        const l = await leaver(c)
        const r = await waive(c, l.byKey('belongings'))
        expect(r.ok, `setting ${on}`).toBe(true)
        expect(r.ok && r.data.status).toBe('waived')
      })
    }
  })
})

describe('AT-020 P-07: clearance items by their owner', () => {
  it('OFF (the default): Reception completes Accommodation Admin items as today; the Maintenance Coordinator only inspection items', async () => {
    const c = await cast()
    const l = await leaver(c)
    expect((await completeItem(c.rec.rc, { itemId: l.byKey('loss_record'), note: 'Reviewed' })).ok).toBe(true)      // an AA-owned item, completed by Reception
    expect((await completeItem(c.rec.rc, { itemId: l.byKey('belongings'), note: 'Cleared' })).ok).toBe(true)
    expect((await completeItem(c.mc.rc, { itemId: l.byKey('inspection'), note: 'Inspected' })).ok).toBe(true)
    const l2 = await leaver(c, { bed: 1 })
    expect(await completeItem(c.mc.rc, { itemId: l2.byKey('belongings'), note: 'x' })).toMatchObject({ ok: false, code: 'forbidden' })
    expect(await completeItem(c.aa.rc, { itemId: l2.byKey('inspection'), note: 'x' })).toMatchObject({ ok: false, code: 'forbidden' })
    const view = await getCase(getDb(), c.rec.rc.actor, l2.caseId, new Date())
    expect(view!.rules.strictItemOwners).toBe(false)
    expect(view!.items.find(i => i.id === l2.byKey('loss_record'))!.me.canWork).toBe(true)
  })

  it('ON: Reception completes only Reception items; the Accommodation Admin and Super Admin complete AA items and Reception items; the Maintenance Coordinator only Maintenance items', async () => {
    await withSetting('clearance.strict_item_owners', true, async () => {
      const c = await cast()
      const l = await leaver(c)
      // Reception on an Accommodation Admin item: refused with reason, owner and next action
      const refused = await completeItem(c.rec.rc, { itemId: l.byKey('loss_record'), note: 'Reviewed' })
      expect(refused).toMatchObject({ ok: false, code: 'forbidden', owner: 'Accommodation Admin', detail: { reason: 'strict_item_owner', proposal: 'P-07' } })
      if (!refused.ok) { expect(refused.reason).toMatch(/belongs to the Accommodation Admin/); expect(refused.next).toMatch(/Accommodation Admin or a Super Admin/) }
      expect(await markOutstanding(c.rec.rc, { itemId: l.byKey('loss_record'), note: 'Waiting for the report' })).toMatchObject({ ok: false, code: 'forbidden', owner: 'Accommodation Admin' })
      expect((await w.q(`SELECT status FROM clearance_item WHERE id = $1`, [l.byKey('loss_record')])).rows[0]).toMatchObject({ status: 'open' })
      // Reception on its own item, the MC on its own: fine
      expect((await completeItem(c.rec.rc, { itemId: l.byKey('belongings'), note: 'Cleared' })).ok).toBe(true)
      expect((await completeItem(c.mc.rc, { itemId: l.byKey('inspection'), note: 'Inspected' })).ok).toBe(true)
      // the Accommodation Admin and the Super Admin complete AA items, and Reception items too
      expect((await completeItem(c.aa.rc, { itemId: l.byKey('loss_record'), note: 'Reviewed' })).ok).toBe(true)
      const l2 = await leaver(c, { bed: 1 })
      expect((await completeItem(c.sa.rc, { itemId: l2.byKey('loss_record'), note: 'Reviewed' })).ok).toBe(true)
      expect((await completeItem(c.aa.rc, { itemId: l2.byKey('belongings'), note: 'Cleared' })).ok).toBe(true)
      // the Maintenance Coordinator still cannot do the others, nor the AA the inspection
      const l3 = await leaver(c, { bed: 2 })
      expect(await completeItem(c.mc.rc, { itemId: l3.byKey('loss_record'), note: 'x' })).toMatchObject({ ok: false, code: 'forbidden' })
      expect(await completeItem(c.mc.rc, { itemId: l3.byKey('belongings'), note: 'x' })).toMatchObject({ ok: false, code: 'forbidden' })
      expect(await completeItem(c.aa.rc, { itemId: l3.byKey('inspection'), note: 'x' })).toMatchObject({ ok: false, code: 'forbidden' })
    })
  })

  it('ON: an item handed to the Accommodation Admin ("who follows it up") is then the AA\'s alone; reopening stays an Accommodation Admin and Super Admin power', async () => {
    await withSetting('clearance.strict_item_owners', true, async () => {
      const c = await cast()
      const l = await leaver(c)
      // Reception may hand its own item to the Accommodation Admin (it is still Reception's to record)
      expect((await markOutstanding(c.rec.rc, { itemId: l.byKey('belongings'), note: 'Bags still in the room', owner: 'AA' })).ok).toBe(true)
      expect(await completeItem(c.rec.rc, { itemId: l.byKey('belongings'), note: 'Done' })).toMatchObject({ ok: false, code: 'forbidden', owner: 'Accommodation Admin' })
      expect((await completeItem(c.aa.rc, { itemId: l.byKey('belongings'), note: 'Collected' })).ok).toBe(true)
      // reopen: Reception cannot (manage_case), the Accommodation Admin can
      expect(await reopenItem(c.rec.rc, { itemId: l.byKey('belongings'), reason: 'Not collected after all' })).toMatchObject({ ok: false, code: 'forbidden' })
      expect((await reopenItem(c.aa.rc, { itemId: l.byKey('belongings'), reason: 'Not collected after all' })).ok).toBe(true)
    })
  })

  it('ON: the case screen shows the owner rule and who may work each item, with reason, owner and next action when not you', async () => {
    await withSetting('clearance.strict_item_owners', true, async () => {
      const c = await cast()
      const l = await leaver(c)
      const asRec = await getCase(getDb(), c.rec.rc.actor, l.caseId, new Date())
      expect(asRec!.rules.strictItemOwners).toBe(true)
      const aaItem = asRec!.items.find(i => i.id === l.byKey('loss_record'))!
      expect(aaItem.me).toMatchObject({ canWork: false, owner: 'Accommodation Admin' })
      expect(aaItem.me.why).toMatch(/belongs to the Accommodation Admin/)
      expect(aaItem.me.next).toMatch(/Accommodation Admin or a Super Admin/)
      expect(asRec!.items.find(i => i.id === l.byKey('belongings'))!.me.canWork).toBe(true)
      const asAa = await getCase(getDb(), c.aa.rc.actor, l.caseId, new Date())
      expect(asAa!.items.find(i => i.id === l.byKey('loss_record'))!.me.canWork).toBe(true)
      expect(asAa!.items.find(i => i.id === l.byKey('inspection'))!.me.canWork).toBe(false)
      const asMc = await getCase(getDb(), c.mc.rc.actor, l.caseId, new Date())
      expect(asMc!.items.find(i => i.id === l.byKey('inspection'))!.me.canWork).toBe(true)
      expect(asMc!.items.find(i => i.id === l.byKey('loss_record'))!.me.canWork).toBe(false)
    })
  })
})

describe('AT-019 P-08: a person who never had a stay, reservation or request', () => {
  /** Nothing at all: no stay, no reservation, no request. */
  const nobody = async () => (await w.mkStaff()).id
  const mark = (by: IsoPerson, staffId: string) => markLeft(by.rc, { staffId, effectiveDate: '2026-10-14', reason: 'Resigned before arriving', confirmPassword: PASSWORD })

  it('OFF (the default): any holder of the action can mark them, as today', async () => {
    const c = await cast()
    const r = await mark(c.aa, await nobody())
    expect(r.ok, JSON.stringify(r)).toBe(true)
    expect(r.ok && r.data.siteId).toBeNull()
    const preview = await previewBulkExit(c.aa.rc, { employeeIds: [(await w.q<{ employee_id: string }>(`SELECT employee_id FROM staff_profile WHERE id = $1`, [await nobody()])).rows[0].employee_id], effectiveDate: '2026-10-14', reason: 'Bulk' })
    expect(preview.ok && preview.data.batch.rows.map(x => x.outcome)).toEqual(['will_mark'])
  })

  it('ON: only a Super Admin; the Accommodation Admin is refused with reason, owner Super Admin and next action; nothing changes', async () => {
    await withSetting('exit.sited_only', true, async () => {
      const c = await cast()
      const staffId = await nobody()
      const r = await mark(c.aa, staffId)
      expect(r).toMatchObject({ ok: false, code: 'forbidden', owner: 'Super Admin', detail: { reason: 'sited_only', proposal: 'P-08' } })
      if (!r.ok) { expect(r.reason).toMatch(/never had a stay, reservation or request/); expect(r.next).toMatch(/Super Admin/) }
      const state = (await w.q<{ employment_status: string }>(`SELECT employment_status FROM staff_profile WHERE id = $1`, [staffId])).rows[0]
      expect(state.employment_status).toBe('active')
      expect((await w.q(`SELECT 1 FROM clearance_case WHERE staff_id = $1`, [staffId])).rowCount).toBe(0)
      // the Super Admin can
      expect((await mark(c.sa, staffId)).ok).toBe(true)
      expect((await w.q<{ employment_status: string }>(`SELECT employment_status FROM staff_profile WHERE id = $1`, [staffId])).rows[0].employment_status).toBe('left')
      // and the single-person preview says the same thing before anyone clicks
      const other = await w.mkStaff()
      const asAa = await findForExit(getDb(), c.aa.rc.actor, other.employeeId)
      expect(asAa).toMatchObject({ canMark: false, blocked: { owner: 'Super Admin' } })
      expect(asAa!.blocked!.why).toMatch(/never had a stay, reservation or request/)
      expect((await findForExit(getDb(), c.sa.rc.actor, other.employeeId))!.canMark).toBe(true)
    })
  })

  it('ON: "never had" means no row in stay, reservation or request, in ANY status; one past row is enough for the Accommodation Admin', async () => {
    await withSetting('exit.sited_only', true, async () => {
      const c = await cast()
      // a closed stay
      const closedStay = await nobody()
      const claim = (await w.q<{ id: string }>(`INSERT INTO bed_claim (bed_id, kind, period, released_at) VALUES ($1, 'stay', '[2026-01-01,2026-02-01)', now()) RETURNING id`, [c.bedIds[2]])).rows[0].id
      await w.q(`INSERT INTO stay (staff_id, bed_id, claim_id, status, stay_type, checked_in_at, checked_out_at, closed_at) VALUES ($1, $2, $3, 'closed', 'permanent', '2026-01-01T10:00:00Z', '2026-02-01T10:00:00Z', '2026-02-02T10:00:00Z')`, [closedStay, c.bedIds[2], claim])
      expect((await mark(c.aa, closedStay)).ok, 'closed stay').toBe(true)
      // a cancelled reservation
      const cancelled = await nobody()
      const claim2 = (await w.q<{ id: string }>(`INSERT INTO bed_claim (bed_id, kind, period, released_at) VALUES ($1, 'reservation', '[2026-03-01,2026-04-01)', now()) RETURNING id`, [c.bedIds[2]])).rows[0].id
      await w.q(`INSERT INTO reservation (staff_id, bed_id, claim_id, eta, source, stay_type, status, cancel_reason) VALUES ($1, $2, $3, now(), 'request', 'contract', 'cancelled', 'Changed plans')`, [cancelled, c.bedIds[2], claim2])
      expect((await mark(c.aa, cancelled)).ok, 'cancelled reservation').toBe(true)
      // a rejected / cancelled request
      for (const status of ['rejected', 'cancelled']) {
        const asked = await nobody()
        await w.q(`INSERT INTO accommodation_request (staff_id, site_id, arrival_date, end_date, stay_type, status) VALUES ($1, $2, '2026-05-01', '2026-06-01', 'contract', $3)`, [asked, c.siteId, status])
        expect((await mark(c.aa, asked)).ok, `${status} request`).toBe(true)
      }
      // a person with a LIVE stay has a site, so the site's Accommodation Admin handles them as always
      const res = await w.person('Res')
      await w.mkStay({ staffId: res.staffId, bedId: c.bedIds[0] })
      expect((await mark(c.aa, res.staffId)).ok).toBe(true)
    })
  })

  it('bulk, ON: the preview shows the row as blocked with the reason and owner; confirming marks nobody; a Super Admin marks them', async () => {
    await withSetting('exit.sited_only', true, async () => {
      const c = await cast()
      const unsited = await w.mkStaff()
      const sited = await w.person('Res')
      await w.mkStay({ staffId: sited.staffId, bedId: c.bedIds[1] })
      const siteds = (await w.q<{ employee_id: string }>(`SELECT employee_id FROM staff_profile WHERE id = $1`, [sited.staffId])).rows[0].employee_id
      const preview = await previewBulkExit(c.aa.rc, { employeeIds: [unsited.employeeId, siteds], effectiveDate: '2026-10-14', reason: 'Bulk resignation' })
      expect(preview.ok, JSON.stringify(preview)).toBe(true)
      if (!preview.ok) return
      const rows = preview.data.batch.rows
      expect(rows.find(r => r.employeeId === unsited.employeeId)).toMatchObject({ outcome: 'blocked', status: 'skipped' })
      expect(rows.find(r => r.employeeId === unsited.employeeId)!.message).toMatch(/only a Super Admin.*Owner: Super Admin/s)
      expect(rows.find(r => r.employeeId === siteds)).toMatchObject({ outcome: 'will_mark' })
      const done = await confirmBulkExit(c.aa.rc, { batchId: preview.data.batchId, confirmPassword: PASSWORD })
      expect(done.ok && done.data.marked).toBe(1)
      expect((await w.q<{ employment_status: string }>(`SELECT employment_status FROM staff_profile WHERE id = $1`, [unsited.id])).rows[0].employment_status).toBe('active')
      expect((await w.q<{ employment_status: string }>(`SELECT employment_status FROM staff_profile WHERE id = $1`, [sited.staffId])).rows[0].employment_status).toBe('left')
      // the Super Admin's preview marks the unsited person
      const p2 = await previewBulkExit(c.sa.rc, { employeeIds: [unsited.employeeId], effectiveDate: '2026-10-14', reason: 'Bulk resignation' })
      expect(p2.ok && p2.data.batch.rows[0].outcome).toBe('will_mark')
      if (!p2.ok) return
      expect((await confirmBulkExit(c.sa.rc, { batchId: p2.data.batchId, confirmPassword: PASSWORD })).ok).toBe(true)
      expect((await w.q<{ employment_status: string }>(`SELECT employment_status FROM staff_profile WHERE id = $1`, [unsited.id])).rows[0].employment_status).toBe('left')
    })
  })

  it('bulk: a preview made while the rule was OFF is checked again at confirm; with it ON the Accommodation Admin\'s row fails with the reason, and nothing is half done', async () => {
    const c = await cast()
    const unsited = await w.mkStaff()
    const preview = await previewBulkExit(c.aa.rc, { employeeIds: [unsited.employeeId], effectiveDate: '2026-10-14', reason: 'Bulk resignation' })
    expect(preview.ok && preview.data.batch.rows[0].outcome).toBe('will_mark')
    if (!preview.ok) return
    await withSetting('exit.sited_only', true, async () => {
      const done = await confirmBulkExit(c.aa.rc, { batchId: preview.data.batchId, confirmPassword: PASSWORD })
      expect(done.ok && done.data).toMatchObject({ marked: 0, failed: 1 })
      expect(done.ok && done.data.batch.rows[0].resultMessage).toMatch(/Super Admin/)
      expect((await w.q<{ employment_status: string }>(`SELECT employment_status FROM staff_profile WHERE id = $1`, [unsited.id])).rows[0].employment_status).toBe('active')
    })
    // setting back OFF: confirming again retries only the failed row, and it works
    const again = await confirmBulkExit(c.aa.rc, { batchId: preview.data.batchId, confirmPassword: PASSWORD })
    expect(again.ok && again.data.marked).toBe(1)
  })

  it('ON or OFF, a repeat on someone already Left stays harmless (idempotent) and an out-of-scope person still reads as not found', async () => {
    const c = await cast()
    const staffId = await nobody()
    expect((await mark(c.aa, staffId)).ok).toBe(true)
    await withSetting('exit.sited_only', true, async () => {
      const again = await mark(c.aa, staffId)
      expect(again.ok && again.data.repeated).toBe(true)
      const elsewhere = await cast()
      const res = await w.person('Res')
      await w.mkStay({ staffId: res.staffId, bedId: elsewhere.bedIds[0] })
      expect(await mark(c.aa, res.staffId)).toMatchObject({ ok: false, code: 'not_found' })
    })
  })
})
