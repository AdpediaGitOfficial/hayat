/**
 * Atomicity: a failure AFTER every write of a command (here forced in the audit insert, the last thing each command does)
 * leaves nothing half-done: no stay, no claim change, no bed state change, no notification. Private database, because the
 * test installs a trigger on audit_event.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createIsolated } from '../access/isolated'
import { FixedClock } from '@/server/clock'
import { NOW, day, kit } from './iso'
import { checkIn } from '@/server/commands/stays/checkIn'
import { executeTransfer } from '@/server/commands/stays/executeTransfer'
import { approveTransfer } from '@/server/commands/stays/decideTransfer'
import { requestSwap, requestTransfer } from '@/server/commands/stays/requestTransfer'
import { processCheckout } from '@/server/commands/stays/checkout'
import { approveExtension, requestExtension } from '@/server/commands/stays/extension'

const iso = await createIsolated()
afterAll(() => iso.close())
const clock = new FixedClock(NOW)
const k = kit(iso, clock)

beforeAll(async () => {
  await k.q(`CREATE TABLE test_fail_on (action text NOT NULL, site_id uuid NOT NULL)`)
  await k.q(`GRANT SELECT ON test_fail_on TO PUBLIC`)
  await k.q(`CREATE FUNCTION test_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF EXISTS (SELECT 1 FROM test_fail_on t WHERE t.action = NEW.action AND t.site_id = NEW.site_id) THEN
        RAISE EXCEPTION 'forced failure after all writes' USING ERRCODE = 'P0001';
      END IF;
      RETURN NEW;
    END $$`)
  await k.q(`CREATE TRIGGER test_fail_audit_trg BEFORE INSERT ON audit_event FOR EACH ROW EXECUTE FUNCTION test_fail_audit()`)
  vi.spyOn(console, 'error').mockImplementation(() => undefined) // the forced failures are logged by design
})
const failAt = (action: string, siteId: string) => k.q(`INSERT INTO test_fail_on (action, site_id) VALUES ($1, $2)`, [action, siteId])
const clearFailures = (siteId: string) => k.q(`DELETE FROM test_fail_on WHERE site_id = $1`, [siteId])
const countNotifications = async (staffId: string) => (await k.q<{ n: number }>(`SELECT count(*)::int AS n FROM notification WHERE to_staff_id = $1`, [staffId]))[0].n

describe('a failure after all the writes rolls everything back', () => {
  it('check-in: no stay, reservation still reserved, claim still a reservation, bed still Available, no notification; the retry then works', async () => {
    const w = await k.world(2)
    const res = await w.res()
    const r = await k.reservation({ bedId: w.bedIds[0], staffId: res.staffId, from: day(0), to: day(10) })
    await failAt('stays.stay.checked_in', w.siteId)
    const out = await checkIn(w.rec.rc, { reservationId: r.reservationId })
    expect(out.ok).toBe(false)
    expect(!out.ok && out.code).toBe('internal')
    expect((await k.reservationRow(r.reservationId)).status).toBe('reserved')
    expect((await k.claimRow(r.claimId)).kind).toBe('reservation')
    expect(await k.bedState(w.bedIds[0])).toBe('available')
    expect(await k.q(`SELECT 1 FROM stay WHERE staff_id = $1`, [res.staffId])).toHaveLength(0)
    expect(await countNotifications(res.staffId)).toBe(0)
    await clearFailures(w.siteId)
    expect((await checkIn(w.rec.rc, { reservationId: r.reservationId })).ok).toBe(true)
  })

  it('transfer: the destination claim is not leaked, the source claim is still live, both beds are as before, the request is still approved (not "failed")', async () => {
    const w = await k.world(3)
    const aa2 = await k.person('AA', { siteIds: [w.siteId] })
    const res = await w.res()
    const s = await k.stay({ bedId: w.bedIds[0], staffId: res.staffId, from: day(-5), to: day(30) })
    const t = await requestTransfer(res.rc, { stayId: s.stayId, destinationBedId: w.bedIds[1], reason: 'x', neededBy: null, linkedExtensionId: null })
    if (!t.ok) throw new Error('setup')
    await approveTransfer(aa2.rc, { id: t.data.id, destinationBedId: null, note: null })
    await failAt('stays.stay.moved', w.siteId)
    const out = await executeTransfer(w.rec.rc, { id: t.data.id })
    expect(!out.ok && out.code).toBe('internal')
    const row = await k.stayRow(s.stayId)
    expect(row).toMatchObject({ bed_id: w.bedIds[0], claim_id: s.claimId, status: 'active' })
    expect((await k.claimRow(s.claimId)).released_at).toBeNull()
    expect(await k.liveClaims(w.bedIds[1])).toHaveLength(0)
    expect(await k.bedState(w.bedIds[0])).toBe('occupied')
    expect(await k.bedState(w.bedIds[1])).toBe('available')
    expect((await k.q(`SELECT status, failure_count FROM transfer_request WHERE id = $1`, [t.data.id]))[0]).toEqual({ status: 'approved', failure_count: 0 })
    expect((await k.audits(t.data.id)).map(a => a.action)).not.toContain('stays.transfer.executed')
    await clearFailures(w.siteId)
    expect((await executeTransfer(w.rec.rc, { id: t.data.id })).ok).toBe(true)
    expect((await k.stayRow(s.stayId)).bed_id).toBe(w.bedIds[1])
  })

  it('swap: both original claims are still live and both residents are where they were', async () => {
    const w = await k.world(2)
    const aa2 = await k.person('AA', { siteIds: [w.siteId] })
    const [ra, rb] = [await w.res(), await w.res()]
    const a = await k.stay({ bedId: w.bedIds[0], staffId: ra.staffId, from: day(-5), to: day(30) })
    const b = await k.stay({ bedId: w.bedIds[1], staffId: rb.staffId, from: day(-5), to: day(30) })
    const c = { via: 'in_person' as const, note: null }
    const sw = await requestSwap(w.aa.rc, { stayId: a.stayId, otherStayId: b.stayId, reason: 'x', neededBy: null, consentFirst: c, consentSecond: c })
    if (!sw.ok) throw new Error('setup')
    await approveTransfer(aa2.rc, { id: sw.data.id, destinationBedId: null, note: null })
    await failAt('stays.stay.moved', w.siteId)
    const out = await executeTransfer(w.rec.rc, { id: sw.data.id })
    expect(!out.ok && out.code).toBe('internal')
    expect(await k.stayRow(a.stayId)).toMatchObject({ bed_id: w.bedIds[0], claim_id: a.claimId })
    expect(await k.stayRow(b.stayId)).toMatchObject({ bed_id: w.bedIds[1], claim_id: b.claimId })
    expect((await k.claimRow(a.claimId)).released_at).toBeNull()
    expect((await k.claimRow(b.claimId)).released_at).toBeNull()
    expect((await k.liveClaims(w.bedIds[0])).map(x => x.id)).toEqual([a.claimId])
    expect((await k.liveClaims(w.bedIds[1])).map(x => x.id)).toEqual([b.claimId])
    expect((await k.q(`SELECT status FROM transfer_request WHERE id = $1`, [sw.data.id]))[0].status).toBe('approved')
    await clearFailures(w.siteId)
    expect((await executeTransfer(w.rec.rc, { id: sw.data.id })).ok).toBe(true)
  })

  it('checkout: the stay stays active, the claim live and the bed Occupied', async () => {
    const w = await k.world(1)
    const res = await w.res()
    const s = await k.stay({ bedId: w.bedIds[0], staffId: res.staffId, from: day(-5), to: day(30) })
    await failAt('stays.stay.checked_out', w.siteId)
    const out = await processCheckout(w.rec.rc, { stayId: s.stayId, note: null })
    expect(!out.ok && out.code).toBe('internal')
    expect(await k.stayRow(s.stayId)).toMatchObject({ status: 'active', checked_out_at: null })
    expect((await k.claimRow(s.claimId)).released_at).toBeNull()
    expect(await k.bedState(w.bedIds[0])).toBe('occupied')
    expect(await countNotifications(res.staffId)).toBe(0)
    await clearFailures(w.siteId)
    expect((await processCheckout(w.rec.rc, { stayId: s.stayId, note: null })).ok).toBe(true)
    expect(await k.bedState(w.bedIds[0])).toBe('needs_cleaning')
  })

  it('extension approval: the claim period is unchanged and the request still open', async () => {
    const w = await k.world(1)
    const res = await w.res()
    const s = await k.stay({ bedId: w.bedIds[0], staffId: res.staffId, from: day(-5), to: day(30) })
    const e = await requestExtension(res.rc, { stayId: s.stayId, newEnd: day(45), reason: null })
    if (!e.ok) throw new Error('setup')
    await failAt('stays.extension.approved', w.siteId)
    const out = await approveExtension(w.aa.rc, { id: e.data.id, note: null })
    expect(!out.ok && out.code).toBe('internal')
    expect((await k.claimRow(s.claimId)).period).toBe(`[${day(-5)},${day(30)})`)
    expect((await k.q(`SELECT status FROM extension_request WHERE id = $1`, [e.data.id]))[0].status).toBe('requested')
    await clearFailures(w.siteId)
    expect((await approveExtension(w.aa.rc, { id: e.data.id, note: null })).ok).toBe(true)
    expect((await k.claimRow(s.claimId)).period).toBe(`[${day(-5)},${day(45)})`)
  })
})
