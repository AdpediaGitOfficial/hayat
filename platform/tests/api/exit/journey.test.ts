/**
 * Proof 6 of docs/STAGE-3.md section 7, the exit journey end to end: check-in, keys issued, Mark as Left, checkout, keys returned,
 * clearance closed, stay closed, cleaning, inspection, bed Available, next waiting resident told.
 *
 * Steps that belong to other work packages are written as the FACTS those packages record (marked "stand-in"): the return of a key
 * (WP-I: a handover_event 'returned' and the item back in the cabinet) and the cleaning and final inspection (WP-J: cleaning_task
 * passed, bed inspection_required then available). At the merge, replace each stand-in with the real command; the assertions stay.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { admin, call, closeAll, PASSWORD } from '../harness'
import { GET as meRoute } from '../../../app/api/v1/auth/me/route'
import { checkIn } from '@/server/commands/stays/checkIn'
import { processCheckout } from '@/server/commands/stays/checkout'
import { markLeft } from '@/server/commands/exit/markLeft'
import { completeItem } from '@/server/commands/exit/items'
import { closeCase } from '@/server/commands/exit/close'
import { notifyFreedBed } from '@/server/commands/waitlist'
import { getDb } from '@/server/db/client'
import { bedState, itemsOf, mkItem, mkReservation, notifs, resident, stayRow, world } from './helpers'
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

    // 2. keys issued (stand-in for WP-I's issue command: the item is held by the resident)
    const key = await mkItem({ siteId: w.siteId, bedId, holderStaffId: r.staffId, code: 'K-JOURNEY' })

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

    // 7. the key comes back (stand-in for WP-I's return command, recorded on the former employee's behalf)
    await admin().query(`UPDATE handover_item SET status = 'in_cabinet', holder_staff_id = NULL WHERE id = $1`, [key])
    await admin().query(`INSERT INTO handover_event (item_id, kind, staff_id, actor_user_id, on_behalf, note) VALUES ($1, 'returned', $2, $3, true, 'Handed in at the desk')`, [key, r.staffId, w.rec.user.id])

    // 8. the rest of the checklist, then the case closes, and with it the stay (checked out AND cleared AND nothing held)
    const by = (k: string) => items.find(i => i.checklist_key === k)!.id
    expect((await completeItem(w.rec.rc(), { itemId: by('belongings'), note: 'Room empty' })).ok).toBe(true)
    expect((await completeItem(w.mc.rc(), { itemId: by('inspection'), note: 'No damage' })).ok).toBe(true)
    const closed = await closeCase(w.aa.rc(), { caseId })
    expect(closed.ok && closed.data.staysClosed).toEqual([stayId])
    expect(await stayRow(stayId)).toMatchObject({ status: 'closed' })
    // clearance complete is NOT bed ready (D-64): the bed is still waiting for cleaning, and nobody can be placed in it
    expect(await bedState(bedId)).toBe('needs_cleaning')

    // 9. cleaning and final inspection (stand-in for WP-J): only then is the bed Available
    await admin().query(`UPDATE cleaning_task SET status = 'cleaned', cleaned_at = now() WHERE bed_id = $1 AND status = 'open'`, [bedId])
    await admin().query(`UPDATE bed SET state = 'inspection_required' WHERE id = $1`, [bedId])
    expect(await bedState(bedId)).toBe('inspection_required')
    await admin().query(`UPDATE cleaning_task SET status = 'passed', inspected_at = now() WHERE bed_id = $1 AND status = 'cleaned'`, [bedId])
    await admin().query(`UPDATE bed SET state = 'available' WHERE id = $1`, [bedId])
    expect(await bedState(bedId)).toBe('available')

    // 10. the next waiting resident is the one the Accommodation Admin is told about
    const told = await getDb().transaction(tx => notifyFreedBed(tx, bedId, new Date('2026-10-14T12:00:00Z'), `journey:${caseId}`))
    expect(told).toBe(true)
    const n = await notifs(`waitlist:bed:${bedId}:journey:${caseId}`)
    expect(n).toHaveLength(1)
    expect(n[0]).toMatchObject({ kind: 'waitlist.bed_free', to_role: 'AA' })

    // history: one case, one audit trail, nothing deleted
    const events = (await admin().query(`SELECT kind FROM clearance_event WHERE case_id = $1 ORDER BY seq`, [caseId])).rows.map(e => e.kind)
    expect(events).toEqual(['opened', 'item_done', 'item_done', 'item_synced', 'closed'])
  })
})
