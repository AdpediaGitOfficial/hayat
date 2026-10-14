/// <reference types="vite/client" />
/**
 * AT-039 (same transaction). The audit event is written in the same transaction as the change it records. A trigger on audit_event raises an
 * error for one chosen action at one site, so the command fails AFTER every other write and after earlier audit rows: the state must be rolled
 * back with it (no change, no audit row, no notification), and once the fault is removed the same command works. Private database: the
 * trigger belongs to this file.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createIsolated } from '../access/isolated'
import { invKit, T0, day, type Cast } from './kit'
import type { Result } from '@/server/command/result'
import type { RequestContext } from '@/server/command/context'
import { approveRequest } from '@/server/commands/requests/approve'
import { rejectRequest } from '@/server/commands/requests/decide'
import { checkIn } from '@/server/commands/stays/checkIn'
import { processCheckout } from '@/server/commands/stays/checkout'
import { issueItem } from '@/server/commands/keys/movements'
import { markLeft } from '@/server/commands/exit/markLeft'
import { createOffer } from '@/server/commands/waitlist/offer'
import { addToWaitlist } from '@/server/commands/waitlist/add'
import { passInspection } from '@/server/commands/readiness/inspect'
import { initiateEmergency } from '@/server/commands/emergency/initiate'
import { setConfig } from '@/server/commands/access/set-config'
import { createBed } from '@/server/commands/property/createBed'

const iso = await createIsolated()
afterAll(() => iso.close())
const k = invKit(iso)
const q = k.q

beforeAll(async () => {
  await q(`CREATE TABLE test_fail_on (action text NOT NULL, site_id uuid NOT NULL)`)
  await q(`GRANT SELECT ON test_fail_on TO PUBLIC`)
  await q(`CREATE FUNCTION test_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF EXISTS (SELECT 1 FROM test_fail_on t WHERE t.action = NEW.action AND t.site_id = NEW.site_id) THEN
        RAISE EXCEPTION 'forced failure after the writes' USING ERRCODE = 'P0001';
      END IF;
      RETURN NEW;
    END $$`)
  await q(`CREATE TRIGGER test_fail_audit_trg BEFORE INSERT ON audit_event FOR EACH ROW EXECUTE FUNCTION test_fail_audit()`)
  vi.spyOn(console, 'error').mockImplementation(() => undefined) // the forced failures are logged by design
})
const failAt = (action: string, siteId: string) => q(`INSERT INTO test_fail_on (action, site_id) VALUES ($1, $2)`, [action, siteId])
const clearFailures = (siteId: string) => q(`DELETE FROM test_fail_on WHERE site_id = $1`, [siteId])

interface Case {
  siteId: string
  /** The audit action whose insert is made to fail (the last write the command makes, or a later one of several). */
  failAction: string
  who: Cast
  run: (rc: RequestContext) => Promise<Result<unknown>>
  /** Everything the command touches. */
  state: () => Promise<string>
}
const fp = async (...qs: [string, unknown[]][]) => JSON.stringify(await Promise.all(qs.map(([s, a]) => q(s, a))))

const CASES: [string, () => Promise<Case>][] = [
  ['approve a request (request, claim, reservation, two audit rows, notifications)', async () => {
    const p = await k.property({ beds: 2 })
    const aa = await k.cast('AA', { siteId: p.siteId })
    const s = await k.staff()
    const requestId = await k.request({ staffId: s.id, siteId: p.siteId })
    return { siteId: p.siteId, failAction: 'requests.reservation.created', who: aa, run: rc => approveRequest(rc, { requestId, bedId: p.bedIds[0] }),
      state: () => fp([`SELECT status, decided_by FROM accommodation_request WHERE id = $1`, [requestId]], [`SELECT count(*)::int AS n FROM reservation WHERE request_id = $1`, [requestId]], [`SELECT count(*)::int AS n FROM bed_claim WHERE bed_id = $1`, [p.bedIds[0]]],
        [`SELECT count(*)::int AS n FROM audit_event WHERE site_id = $1`, [p.siteId]], [`SELECT count(*)::int AS n FROM notification WHERE site_id = $1 OR ref_id = $2`, [p.siteId, requestId]]) }
  }],
  ['reject a request', async () => {
    const p = await k.property({ beds: 1 })
    const aa = await k.cast('AA', { siteId: p.siteId })
    const s = await k.staff()
    const requestId = await k.request({ staffId: s.id, siteId: p.siteId })
    return { siteId: p.siteId, failAction: 'requests.request.rejected', who: aa, run: rc => rejectRequest(rc, { requestId, reason: 'No capacity this month' }),
      state: () => fp([`SELECT status, decided_by, decision_reason FROM accommodation_request WHERE id = $1`, [requestId]], [`SELECT count(*)::int AS n FROM audit_event WHERE site_id = $1`, [p.siteId]], [`SELECT count(*)::int AS n FROM notification WHERE ref_id = $1`, [requestId]]) }
  }],
  ['check in (reservation, claim, stay, bed)', async () => {
    const p = await k.property({ beds: 1 })
    const rec = await k.cast('Rec', { siteId: p.siteId })
    const s = await k.staff()
    const r = await k.reservation({ bedId: p.bedIds[0], staffId: s.id, from: day(0), to: day(10) })
    return { siteId: p.siteId, failAction: 'stays.stay.checked_in', who: rec, run: rc => checkIn(rc, { reservationId: r.reservationId }),
      state: () => fp([`SELECT status FROM reservation WHERE id = $1`, [r.reservationId]], [`SELECT count(*)::int AS n FROM stay WHERE staff_id = $1`, [s.id]], [`SELECT state FROM bed WHERE id = $1`, [p.bedIds[0]]], [`SELECT kind FROM bed_claim WHERE bed_id = $1 AND released_at IS NULL`, [p.bedIds[0]]], [`SELECT count(*)::int AS n FROM audit_event WHERE site_id = $1`, [p.siteId]]) }
  }],
  ['process a checkout (stay, claim, bed, cleaning task)', async () => {
    const p = await k.property({ beds: 1 })
    const rec = await k.cast('Rec', { siteId: p.siteId })
    const s = await k.staff()
    const st = await k.stay({ bedId: p.bedIds[0], staffId: s.id, from: day(-5), to: day(30) })
    return { siteId: p.siteId, failAction: 'stays.stay.checked_out', who: rec, run: rc => processCheckout(rc, { stayId: st.stayId, note: null }),
      state: () => fp([`SELECT status FROM stay WHERE id = $1`, [st.stayId]], [`SELECT state FROM bed WHERE id = $1`, [p.bedIds[0]]], [`SELECT released_at FROM bed_claim WHERE id = $1`, [st.claimId]], [`SELECT count(*)::int AS n FROM cleaning_task WHERE bed_id = $1`, [p.bedIds[0]]], [`SELECT count(*)::int AS n FROM audit_event WHERE site_id = $1`, [p.siteId]]) }
  }],
  ['issue a key (item and event log)', async () => {
    const p = await k.property({ beds: 1 })
    const rec = await k.cast('Rec', { siteId: p.siteId })
    const s = await k.staff()
    await k.stay({ bedId: p.bedIds[0], staffId: s.id, from: day(-5), to: day(30) })
    const itemId = (await q<{ id: string }>(`INSERT INTO handover_item (category, item_type, code, site_id, bed_id) VALUES ('key', 'room_key', $1, $2, $3) RETURNING id`, [k.uniq('K'), p.siteId, p.bedIds[0]]))[0].id
    return { siteId: p.siteId, failAction: 'keys.item.issued', who: rec, run: rc => issueItem(rc, { itemId, staffId: s.id, dueBack: null, note: null }),
      state: () => fp([`SELECT status, holder_staff_id FROM handover_item WHERE id = $1`, [itemId]], [`SELECT count(*)::int AS n FROM handover_event WHERE item_id = $1`, [itemId]], [`SELECT count(*)::int AS n FROM audit_event WHERE site_id = $1`, [p.siteId]]) }
  }],
  ['mark an employee as Left (login, reservations, waitlist, case, items, audit)', async () => {
    const p = await k.property({ beds: 2 })
    const aa = await k.cast('AA', { siteId: p.siteId })
    const res = await k.cast('Res')
    const st = await k.stay({ bedId: p.bedIds[0], staffId: res.staffId, from: '2026-10-01', to: null })
    await q(`UPDATE stay SET checked_in_at = '2026-10-01T10:00:00Z' WHERE id = $1`, [st.stayId])
    return { siteId: p.siteId, failAction: 'exit.staff.marked_left', who: aa, run: rc => markLeft(rc, { staffId: res.staffId, effectiveDate: '2026-10-14', reason: 'Resigned', confirmPassword: aa.password }),
      state: () => fp([`SELECT employment_status FROM staff_profile WHERE id = $1`, [res.staffId]], [`SELECT status FROM user_account WHERE id = $1`, [res.userId]], [`SELECT count(*)::int AS n FROM clearance_case WHERE staff_id = $1`, [res.staffId]], [`SELECT status FROM stay WHERE id = $1`, [st.stayId]], [`SELECT count(*)::int AS n FROM audit_event WHERE entity_id = $1 OR site_id = $2`, [res.staffId, p.siteId]]) }
  }],
  ['offer a held bed (offer, hold, entry, notification)', async () => {
    const p = await k.property({ beds: 1 })
    const aa = await k.cast('AA', { siteId: p.siteId })
    const s = await k.staff()
    const e = await addToWaitlist(aa.rc(), { staffId: s.id, siteId: p.siteId, arrival: day(5) })
    if (!e.ok) throw new Error(e.reason)
    return { siteId: p.siteId, failAction: 'waitlist.offer.created', who: aa, run: rc => createOffer(rc, { entryId: e.data.entryId, bedId: p.bedIds[0] }),
      state: () => fp([`SELECT status FROM waitlist_entry WHERE id = $1`, [e.data.entryId]], [`SELECT count(*)::int AS n FROM bed_offer WHERE waitlist_entry_id = $1`, [e.data.entryId]], [`SELECT count(*)::int AS n FROM bed_claim WHERE bed_id = $1`, [p.bedIds[0]]], [`SELECT count(*)::int AS n FROM audit_event WHERE site_id = $1`, [p.siteId]]) }
  }],
  ['pass a final inspection (task, bed state, audit)', async () => {
    const p = await k.property({ beds: 1 })
    const insp = await k.cast('AA', { siteId: p.siteId, caps: ['FinalInspection'] })
    const hk = await k.staff()
    for (const s of ['occupied', 'needs_cleaning', 'inspection_required']) await q(`UPDATE bed SET state = $2 WHERE id = $1`, [p.bedIds[0], s])
    const taskId = (await q<{ id: string }>(`INSERT INTO cleaning_task (bed_id, site_id, reason, status, cleaned_by_staff, cleaned_at, checklist) VALUES ($1, $2, 'Checked out', 'cleaned', $3, now(), '{}'::jsonb) RETURNING id`, [p.bedIds[0], p.siteId, hk.id]))[0].id
    return { siteId: p.siteId, failAction: 'readiness.inspection.passed', who: insp, run: rc => passInspection(rc, { taskId, note: null }),
      state: () => fp([`SELECT status, inspected_by_staff FROM cleaning_task WHERE id = $1`, [taskId]], [`SELECT state FROM bed WHERE id = $1`, [p.bedIds[0]]], [`SELECT count(*)::int AS n FROM audit_event WHERE site_id = $1`, [p.siteId]]) }
  }],
  ['start an emergency check-in (case, provisional stay, claim, bed)', async () => {
    const p = await k.property({ beds: 1 })
    const rec = await k.cast('Rec', { siteId: p.siteId, caps: ['EmergencyCheckin'] })
    const s = await k.staff()
    return { siteId: p.siteId, failAction: 'emergency.initiated', who: rec, run: rc => initiateEmergency(rc, { staffId: s.id, bedId: p.bedIds[0], reason: 'Flood in block B, relocated overnight' }),
      state: () => fp([`SELECT count(*)::int AS n FROM emergency_checkin WHERE staff_id = $1`, [s.id]], [`SELECT count(*)::int AS n FROM stay WHERE staff_id = $1`, [s.id]], [`SELECT state FROM bed WHERE id = $1`, [p.bedIds[0]]], [`SELECT count(*)::int AS n FROM bed_claim WHERE bed_id = $1`, [p.bedIds[0]]], [`SELECT count(*)::int AS n FROM audit_event WHERE site_id = $1`, [p.siteId]]) }
  }],
  ['save a setting (a new configuration version)', async () => {
    const p = await k.property({ beds: 0 })
    const sup = await k.cast('SA')
    return { siteId: p.siteId, failAction: 'config.changed', who: sup, run: rc => setConfig(rc, { key: 'calendar.weekend_days', value: [5, 6], siteId: p.siteId, reason: 'Weekend is Friday and Saturday here' }),
      state: () => fp([`SELECT count(*)::int AS n FROM config_item WHERE key = 'calendar.weekend_days' AND scope_site_id = $1`, [p.siteId]], [`SELECT count(*)::int AS n FROM audit_event WHERE site_id = $1`, [p.siteId]]) }
  }],
  ['create a bed', async () => {
    const p = await k.property({ beds: 0 })
    const aa = await k.cast('AA', { siteId: p.siteId })
    return { siteId: p.siteId, failAction: 'property.bed.created', who: aa, run: rc => createBed(rc, { roomId: p.roomId, code: 'NB-1' }),
      state: () => fp([`SELECT count(*)::int AS n FROM bed WHERE room_id = $1`, [p.roomId]], [`SELECT count(*)::int AS n FROM audit_event WHERE site_id = $1`, [p.siteId]]) }
  }],
]

describe('AT-039 the audit event and the change commit or roll back together', () => {
  it.each(CASES)('%s', async (_name, make) => {
    const c = await make()
    const before = await c.state()
    await failAt(c.failAction, c.siteId)
    const rc = { ...c.who.rc(), requestId: 'atomic-' + crypto.randomUUID() }
    const r = await c.run(rc)
    expect(r.ok, 'the command fails when its audit write fails').toBe(false)
    expect(!r.ok && r.code).toBe('internal')
    expect(await c.state(), 'every write rolled back with the audit row').toBe(before)
    expect((await q(`SELECT 1 FROM audit_event WHERE request_id = $1`, [rc.requestId])), 'no audit row survives').toHaveLength(0)
    await clearFailures(c.siteId)
    const again = await c.run({ ...c.who.rc(), requestId: 'atomic-' + crypto.randomUUID() })
    expect(again.ok, again.ok ? '' : `${again.code}: ${again.reason}`).toBe(true)
    expect(await c.state(), 'and once the fault is gone the same command goes through').not.toBe(before)
  })
})

void T0
