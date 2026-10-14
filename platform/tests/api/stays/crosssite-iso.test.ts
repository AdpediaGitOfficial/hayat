/**
 * D-104 against a PRIVATE database (a sweep looks at every row it can see; the atomicity test installs a trigger on audit_event):
 *  - the approvals inbox: one item per missing key, each at the site that owns it, "mine" only for someone who can approve that side;
 *  - sweeps and timers remind and escalate each site on its own, and decide nothing;
 *  - a failure after every write of a cross-site move (or swap) rolls ALL of it back: the resident is where they were, the follow-ups
 *    did not happen, the request is still approved (not "failed"), and the retry then works.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createIsolated } from '../access/isolated'
import { FixedClock } from '@/server/clock'
import { DAY_MS, NOW, day, kit } from './iso'
import { getDb } from '@/server/db/client'
import { listInbox } from '@/server/approvals/inbox'
import { runSweep } from '@/server/jobs/registry'
import '@/server/jobs/sweeps'
import { approveTransfer, recordSwapConsent } from '@/server/commands/stays/decideTransfer'
import { executeTransfer } from '@/server/commands/stays/executeTransfer'
import { requestSwap, requestTransfer } from '@/server/commands/stays/requestTransfer'
import { requestExtension } from '@/server/commands/stays/extension'

const iso = await createIsolated()
afterAll(() => iso.close())
const clock = new FixedClock(NOW)
const k = kit(iso, clock)
const none = { note: null }

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

async function named(label: string, beds = 3) {
  const w = await k.world(beds)
  const name = `${label} ${k.uniq('s')}`
  await k.q(`UPDATE site SET name = $2 WHERE id = $1`, [w.siteId, name])
  return { ...w, name }
}
async function scene() {
  const src = await named('Source'), dst = await named('Destination'), third = await named('Third', 1)
  const dstAa2 = await k.person('AA', { siteIds: [dst.siteId] })
  const res = await src.res()
  const s = await k.stay({ bedId: src.bedIds[0], staffId: res.staffId, from: day(-5), to: day(30) })
  const r = await requestTransfer(res.rc, { stayId: s.stayId, destinationBedId: dst.bedIds[1], destinationSiteId: null, reason: 'New project', neededBy: null, linkedExtensionId: null })
  if (!r.ok) throw new Error('setup: ' + r.reason)
  return { src, dst, third, dstAa2, res, ...s, id: r.data.id }
}

describe('the approvals inbox shows each key at the site that owns it', () => {
  it('source key: the source admin\'s item, "mine"; destination key: the destination admin\'s item, "mine"; nobody else (a third site\'s admin) sees either; the raiser cannot decide', async () => {
    const sc = await scene()
    const now = new Date(NOW)
    const mine = async (p: { rc: { actor: Parameters<typeof listInbox>[1] } }) => (await listInbox(getDb(), p.rc.actor, now)).filter(i => i.ref === sc.id)

    const srcItems = await mine(sc.src.aa)
    expect(srcItems.map(i => [i.kind, i.siteId, i.mine])).toEqual([['transfer', sc.src.siteId, true]])
    expect(srcItems[0].title).toContain(sc.dst.name)
    const dstItems = await mine(sc.dst.aa)
    expect(dstItems.map(i => [i.kind, i.siteId, i.mine])).toEqual([['transfer_in', sc.dst.siteId, true]])
    expect(dstItems[0].sub).toMatch(/you choose the bed/)
    expect(await mine(sc.third.aa)).toEqual([])
    // Reception at the destination may look? no: the inbox is for those who can decide at some level
    expect(await mine(sc.dst.rec)).toEqual([])

    // one key given: that item is gone, the other remains for the other site
    expect((await approveTransfer(sc.src.aa.rc, { id: sc.id, destinationBedId: null, ...none })).ok).toBe(true)
    expect(await mine(sc.src.aa)).toEqual([])
    expect((await mine(sc.dst.aa)).map(i => [i.kind, i.mine])).toEqual([['transfer_in', true]])
    // the resident (a subject) cannot be an approver here; an admin who is also the subject sees it but cannot decide
    const self = { rc: { actor: { ...sc.dst.aa.rc.actor, staffId: sc.res.staffId } } }
    const own = await mine(self)
    expect(own).toHaveLength(1)
    expect(own[0].mine).toBe(false)
    expect(own[0].why).toMatch(/separation of duties/)
    // both keys: nothing left to decide, anywhere
    expect((await approveTransfer(sc.dst.aa.rc, { id: sc.id, destinationBedId: null, ...none })).ok).toBe(true)
    expect(await mine(sc.src.aa)).toEqual([])
    expect(await mine(sc.dst.aa)).toEqual([])
  })

  it('a same-site request is ONE item at its site (unchanged)', async () => {
    const w = await named('Only')
    const aa2 = await k.person('AA', { siteIds: [w.siteId] })
    const res = await w.res()
    const s = await k.stay({ bedId: w.bedIds[0], staffId: res.staffId, from: day(-5), to: day(30) })
    const r = await requestTransfer(res.rc, { stayId: s.stayId, destinationBedId: w.bedIds[1], reason: 'x', neededBy: null, linkedExtensionId: null })
    if (!r.ok) throw new Error('setup')
    const items = (await listInbox(getDb(), aa2.rc.actor, new Date(NOW))).filter(i => i.ref === r.data.id)
    expect(items.map(i => [i.kind, i.siteId, i.mine])).toEqual([['transfer', w.siteId, true]])
  })
})

describe('timers remind each site on its own and decide nothing', () => {
  it('reminders and escalations go to the Accommodation Admin of the site whose key is missing; the keys, the request, the stay and the beds are never touched', async () => {
    const sc = await scene()
    const ext = await requestExtension(sc.res.rc, { stayId: sc.stayId, newEnd: day(36), reason: 'x' })
    expect(ext.ok).toBe(true)
    await approveTransfer(sc.src.aa.rc, { id: sc.id, destinationBedId: null, ...none }) // only the destination key is missing now

    for (const days of [1, 2, 3, 5, 10, 30, 90]) {
      clock.set(NOW + days * DAY_MS)
      for (const name of ['stays_no_show', 'stays_end_reminders', 'stays_overdue', 'stays_checkout_reminders', 'approval_reminders']) await runSweep(name, clock)
    }
    clock.set(NOW)

    const t = (await k.q(`SELECT status, source_approved_at, destination_approved_at, executed_at, decided_at FROM transfer_request WHERE id = $1`, [sc.id]))[0]
    expect(t.status).toBe('requested')
    expect(t.source_approved_at).not.toBeNull()
    expect(t.destination_approved_at).toBeNull()
    expect(t.executed_at).toBeNull()
    expect(t.decided_at).toBeNull()
    expect((await k.stayRow(sc.stayId)).bed_id).toBe(sc.src.bedIds[0])
    expect((await k.claimRow(sc.claimId)).released_at).toBeNull()
    expect(await k.bedState(sc.dst.bedIds[1])).toBe('available')
    expect(await k.bedState(sc.src.bedIds[0])).toBe('occupied')

    // the destination key's reminders sit at the destination site; the source key, already given, gets none
    const rows = await k.q<{ dedupe_key: string; kind: string; to_role: string; site_id: string }>(
      `SELECT dedupe_key, kind, to_role, site_id FROM notification WHERE dedupe_key LIKE $1 ORDER BY dedupe_key`, [`approval:transfer%:${sc.id}:%`])
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every(r => r.dedupe_key.startsWith(`approval:transfer_in:${sc.id}:`))).toBe(true)
    expect(rows.find(r => r.kind === 'approval.reminder')).toMatchObject({ to_role: 'AA', site_id: sc.dst.siteId })
    expect(rows.map(r => r.kind)).toEqual(expect.arrayContaining(['approval.reminder', 'approval.backup', 'approval.escalated']))
    expect(rows.find(r => r.kind === 'approval.backup')?.site_id).toBe(sc.dst.siteId)
    expect(rows.find(r => r.kind === 'approval.escalated')?.site_id).toBe(sc.dst.siteId)
  })

  it('with NO key given both sites are reminded, each under its own kind, so neither reminder hides the other', async () => {
    const sc = await scene()
    clock.set(NOW + 3 * DAY_MS)
    await runSweep('approval_reminders', clock)
    clock.set(NOW)
    const rows = await k.q<{ dedupe_key: string; to_role: string; site_id: string }>(
      `SELECT dedupe_key, to_role, site_id FROM notification WHERE dedupe_key LIKE $1 AND kind = 'approval.reminder'`, [`approval:transfer%:${sc.id}:%`])
    expect(rows.map(r => [r.dedupe_key.split(':')[1], r.to_role, r.site_id]).sort()).toEqual([['transfer', 'AA', sc.src.siteId], ['transfer_in', 'AA', sc.dst.siteId]].sort())
    expect((await k.q(`SELECT status FROM transfer_request WHERE id = $1`, [sc.id]))[0].status).toBe('requested')
  })
})

describe('a failure after every write rolls the whole cross-site move back', () => {
  it('transfer: stay, claims, both beds, the cleaning task and the follow-ups are as before; the request is still approved; the retry works', async () => {
    const sc = await scene()
    const ext = await requestExtension(sc.res.rc, { stayId: sc.stayId, newEnd: day(36), reason: 'x' })
    if (!ext.ok) throw new Error('setup')
    await approveTransfer(sc.src.aa.rc, { id: sc.id, destinationBedId: null, ...none })
    await approveTransfer(sc.dst.aa.rc, { id: sc.id, destinationBedId: null, ...none })
    await failAt('stays.stay.moved', sc.dst.siteId) // the stay's move event is written at the destination site: the very last write
    const out = await executeTransfer(sc.src.rec.rc, { id: sc.id })
    expect(!out.ok && out.code).toBe('internal')

    expect(await k.stayRow(sc.stayId)).toMatchObject({ bed_id: sc.src.bedIds[0], claim_id: sc.claimId, status: 'active' })
    expect((await k.claimRow(sc.claimId)).released_at).toBeNull()
    expect(await k.liveClaims(sc.dst.bedIds[1])).toHaveLength(0)
    expect(await k.bedState(sc.src.bedIds[0])).toBe('occupied')
    expect(await k.bedState(sc.dst.bedIds[1])).toBe('available')
    expect(await k.q(`SELECT 1 FROM cleaning_task WHERE bed_id = $1`, [sc.src.bedIds[0]])).toHaveLength(0)
    expect((await k.q(`SELECT site_id FROM extension_request WHERE id = $1`, [ext.data.id]))[0].site_id).toBe(sc.src.siteId) // not re-sited
    expect((await k.q(`SELECT status, failure_count, source_approved_at IS NOT NULL AS s, destination_approved_at IS NOT NULL AS d FROM transfer_request WHERE id = $1`, [sc.id]))[0])
      .toEqual({ status: 'approved', failure_count: 0, s: true, d: true })
    expect((await k.audits(sc.id)).map(a => a.action)).not.toContain('stays.transfer.executed')
    expect((await k.q(`SELECT 1 FROM notification WHERE to_staff_id = $1 AND kind = 'transfer.executed'`, [sc.res.staffId]))).toHaveLength(0)

    await clearFailures(sc.dst.siteId)
    expect((await executeTransfer(sc.src.rec.rc, { id: sc.id })).ok).toBe(true)
    expect((await k.stayRow(sc.stayId)).bed_id).toBe(sc.dst.bedIds[1])
    expect((await k.q(`SELECT site_id FROM extension_request WHERE id = $1`, [ext.data.id]))[0].site_id).toBe(sc.dst.siteId)
  })

  it('swap: both residents are where they were, both original claims are live', async () => {
    const src = await named('Source', 2), dst = await named('Destination', 2)
    const dstAa2 = await k.person('AA', { siteIds: [dst.siteId] })
    const [ra, rb] = [await src.res(), await dst.res()]
    const a = await k.stay({ bedId: src.bedIds[0], staffId: ra.staffId, from: day(-5), to: day(30) })
    const b = await k.stay({ bedId: dst.bedIds[0], staffId: rb.staffId, from: day(-5), to: day(30) })
    const c = { via: 'in_person' as const, note: null }
    const sw = await requestSwap(src.aa.rc, { stayId: a.stayId, otherStayId: b.stayId, reason: 'x', neededBy: null, consentFirst: c, consentSecond: c })
    if (!sw.ok) throw new Error('setup: ' + sw.reason)
    const srcAa2 = await k.person('AA', { siteIds: [src.siteId] })
    await approveTransfer(srcAa2.rc, { id: sw.data.id, destinationBedId: null, ...none })
    await approveTransfer(dstAa2.rc, { id: sw.data.id, destinationBedId: null, ...none })
    await failAt('stays.stay.left_site', src.siteId)
    const out = await executeTransfer(dst.rec.rc, { id: sw.data.id })
    expect(!out.ok && out.code).toBe('internal')
    expect(await k.stayRow(a.stayId)).toMatchObject({ bed_id: src.bedIds[0], claim_id: a.claimId })
    expect(await k.stayRow(b.stayId)).toMatchObject({ bed_id: dst.bedIds[0], claim_id: b.claimId })
    expect((await k.claimRow(a.claimId)).released_at).toBeNull()
    expect((await k.claimRow(b.claimId)).released_at).toBeNull()
    expect((await k.liveClaims(src.bedIds[0])).map(x => x.id)).toEqual([a.claimId])
    expect((await k.liveClaims(dst.bedIds[0])).map(x => x.id)).toEqual([b.claimId])
    expect((await k.q(`SELECT status FROM transfer_request WHERE id = $1`, [sw.data.id]))[0].status).toBe('approved')
    await clearFailures(src.siteId)
    expect((await executeTransfer(dst.rec.rc, { id: sw.data.id })).ok).toBe(true)
    expect([(await k.stayRow(a.stayId)).bed_id, (await k.stayRow(b.stayId)).bed_id]).toEqual([dst.bedIds[0], src.bedIds[0]])
  })
})

void recordSwapConsent
