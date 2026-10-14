/**
 * Proof 6 of docs/STAGE-3.md section 7, the exit journey end to end: check-in, keys issued, Mark as Left, checkout, keys returned,
 * clearance closed, stay closed, cleaning, inspection, bed Available, next waiting resident told.
 *
 * Every step uses the real command of its package: check-in and checkout (WP-F), issuing and returning the key (WP-I), Mark as Left and
 * clearance (WP-H), cleaning and final inspection (WP-J), the freed-bed notice (WP-E).
 */
import { afterAll, describe, expect, it } from 'vitest'
import { admin, call, closeAll, PASSWORD } from '../harness'
import { GET as meRoute } from '../../../app/api/v1/auth/me/route'
import { checkIn } from '@/server/commands/stays/checkIn'
import { processCheckout } from '@/server/commands/stays/checkout'
import { markLeft } from '@/server/commands/exit/markLeft'
import { completeItem } from '@/server/commands/exit/items'
import { closeCase } from '@/server/commands/exit/close'
import { issueItem, returnItem } from '@/server/commands/keys/movements'
import { assignCleaning } from '@/server/commands/readiness/assign'
import { completeCleaning } from '@/server/commands/readiness/clean'
import { passInspection } from '@/server/commands/readiness/inspect'
import { bedState, itemsOf, mkItem, mkReservation, notifs, resident, stayRow, who, world } from './helpers'
import { cleaningTasks } from '../fixtures3'

afterAll(closeAll)

describe('the exit journey', () => {
  it('check-in -> keys issued -> Mark as Left -> checkout -> keys returned -> clearance closed -> stay closed -> cleaning -> inspection -> bed Available -> next waiting resident told', async () => {
    const w = await world()
    const bedId = w.bedIds[0]
    const r = await resident()

    // 1. a reservation for today and check-in by Reception (WP-F)
    const rsv = await mkReservation({ bedId, staffId: r.staffId, from: '2026-10-14', to: null })
    const inn = await checkIn(w.rec.rc(), { reservationId: rsv.reservationId })
    expect(inn.ok, JSON.stringify(inn)).toBe(true)
    if (!inn.ok) return
    const stayId = inn.data.stayId
    expect(await bedState(bedId)).toBe('occupied')

    // 2. Reception issues the bed's key (WP-I)
    const key = await mkItem({ siteId: w.siteId, bedId, code: 'K-JOURNEY' })
    const issued = await issueItem(w.rec.rc(), { itemId: key, staffId: r.staffId, dueBack: null, note: null })
    expect(issued.ok, JSON.stringify(issued)).toBe(true)

    // 3. someone else is waiting for a bed at the site
    const waiting = await resident()
    await admin().query(`INSERT INTO waitlist_entry (staff_id, site_id, expires_at, arrival_date, stay_type, status) VALUES ($1, $2, '2026-12-01', '2026-10-20', 'contract', 'waiting')`, [waiting.staffId, w.siteId])

    // 4. Mark as Left: login ends at once; the stay and the bed are untouched; the key is on the case
    const left = await markLeft(w.aa.rc(), { staffId: r.staffId, effectiveDate: '2026-10-14', reason: 'Resigned, last day today', confirmPassword: PASSWORD })
    expect(left.ok, JSON.stringify(left)).toBe(true)
    if (!left.ok) return
    const caseId = left.data.caseId
    expect((await call(meRoute, { cookie: r.cookie })).status).toBe(401)
    expect(await stayRow(stayId)).toMatchObject({ status: 'active' })
    expect(await bedState(bedId)).toBe('occupied')
    const items = await itemsOf(caseId)
    expect(items.find(i => i.handover_item_id === key)).toMatchObject({ kind: 'handover', status: 'open', mandatory: true })

    // 5. checkout by Reception: the bed becomes Needs cleaning (and a cleaning task opens), the stay is checked out but NOT closed
    const out = await processCheckout(w.rec.rc(), { stayId, note: 'Left with two bags' })
    expect(out.ok).toBe(true)
    expect(await stayRow(stayId)).toMatchObject({ status: 'checked_out', closed_at: null })
    expect(await bedState(bedId)).toBe('needs_cleaning')
    expect((await cleaningTasks(bedId)).map(t => t.status)).toEqual(['open'])

    // 6. the case cannot close yet: the key is still held
    expect(await closeCase(w.aa.rc(), { caseId })).toMatchObject({ ok: false, code: 'conflict' })

    // 7. the key comes back, recorded by Reception on the former employee's behalf (WP-I)
    const back = await returnItem(w.rec.rc(), { itemId: key, note: 'Handed in at the desk', onBehalf: true })
    expect(back.ok, JSON.stringify(back)).toBe(true)
    expect(await stayRow(stayId)).toMatchObject({ status: 'checked_out' }) // the case is still open

    // 8. the rest of the checklist, then the case closes, and with it the stay (checked out AND cleared AND nothing held)
    const by = (k: string) => items.find(i => i.checklist_key === k)!.id
    expect((await completeItem(w.rec.rc(), { itemId: by('belongings'), note: 'Room empty' })).ok).toBe(true)
    expect((await completeItem(w.mc.rc(), { itemId: by('inspection'), note: 'No damage' })).ok).toBe(true)
    const closed = await closeCase(w.aa.rc(), { caseId })
    expect(closed.ok && closed.data.staysClosed).toEqual([stayId])
    expect(await stayRow(stayId)).toMatchObject({ status: 'closed' })
    // clearance complete is NOT bed ready (D-64): the bed is still waiting for cleaning, and nobody can be placed in it
    expect(await bedState(bedId)).toBe('needs_cleaning')

    // 9. cleaning by an assigned housekeeper, then the final inspection by a different person (WP-J): only then is the bed Available
    const hk = await who('Res', { caps: ['Housekeeping'] })
    const insp = await who('Rec', { siteIds: [w.siteId], caps: ['FinalInspection'] })
    const task = (await cleaningTasks(bedId))[0]
    expect((await assignCleaning(w.rec.rc(), { taskId: task.id, housekeeperStaffId: hk.user.staffId, note: null })).ok).toBe(true)
    const cleaned = await completeCleaning(hk.rc(), { taskId: task.id, checklist: { linen: true, surfaces: true, bathroom: true, bins: true }, notes: null } as never)
    expect(cleaned.ok, JSON.stringify(cleaned)).toBe(true)
    expect(await bedState(bedId)).toBe('inspection_required')           // cleaning alone does not make it Available
    const passed = await passInspection(insp.rc(), { taskId: task.id, note: null })
    expect(passed.ok, JSON.stringify(passed)).toBe(true)
    expect(await bedState(bedId)).toBe('available')

    // 10. the next waiting resident is the one the Accommodation Admin is told about; no offer was created by itself
    const n = await notifs(`waitlist:bed:${bedId}`)
    expect(n).toHaveLength(1)
    expect(n[0]).toMatchObject({ kind: 'waitlist.bed_free', to_role: 'AA' })
    expect((await admin().query(`SELECT count(*)::int AS n FROM bed_offer WHERE staff_id = $1`, [waiting.staffId])).rows[0].n).toBe(0)

    // history: one case, one audit trail, nothing deleted
    const events = (await admin().query(`SELECT kind FROM clearance_event WHERE case_id = $1 ORDER BY seq`, [caseId])).rows.map(e => e.kind)
    expect(events).toEqual(['opened', 'item_done', 'item_done', 'item_synced', 'closed'])
  })
})
