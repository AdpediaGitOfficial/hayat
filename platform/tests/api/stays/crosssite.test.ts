/**
 * D-104: transfers and swaps may cross sites, with two keys (the Accommodation Admin of the source site AND of the destination site),
 * revalidation at the destination, one atomic execution, and the stay belonging to the new site afterwards.
 * Same-site flows are covered unchanged by transfer.test.ts (AT-022) and the rest of this folder.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { admin, closeAll } from '../harness'
import {
  as, auditRows, bedState, claimRow, day, DAY_MS, liveClaims, mkReservation, newClock, NOW, person, residents, setBedState, stayRow, transferRow, mkStay,
} from './helpers'
import { FixedClock } from '@/server/clock'
import { approveTransfer, recordSwapConsent, rejectTransfer } from '@/server/commands/stays/decideTransfer'
import { executeTransfer } from '@/server/commands/stays/executeTransfer'
import { requestSwap, requestTransfer } from '@/server/commands/stays/requestTransfer'
import { requestExtension } from '@/server/commands/stays/extension'
import { cancelRequest } from '@/server/commands/stays/cancel'
import { crossSiteFollowUpIds, registerCrossSiteFollowUp } from '@/server/commands/stays/crossSite'
import { getStayDetail, listStays } from '@/server/queries/stays/stays'
import { listTransfers } from '@/server/queries/stays/transfers'
import { approvedByBoth, cross, nameOfSite, requested, swapRequested, twoStays, xreq } from './crossHelpers'

afterAll(closeAll)

const noteBase = { note: null }
const notes = async (refId: string) =>
  (await admin().query<{ kind: string; to_role: string | null; to_staff_id: string | null; site_id: string | null; text: string }>(
    `SELECT kind, to_role, to_staff_id, site_id, text FROM notification WHERE ref_id = $1 ORDER BY dedupe_key`, [refId])).rows

describe('cross-site request (D-104)', () => {
  it('a resident asks for a bed in ANOTHER site without any scope there: both sites\' Accommodation Admins are told, the destination site is stored, audit carries both sites', async () => {
    const sc = await cross()
    const r = await requestTransfer(sc.res.rc, xreq(sc.stayId, sc.dst.bedIds[1]))
    expect(r.ok && r.data).toMatchObject({ status: 'requested', crossSite: true })
    if (!r.ok) return
    const t = await transferRow(r.data.id)
    expect(t).toMatchObject({ site_id: sc.src.siteId, destination_site_id: sc.dst.siteId, to_bed_id: sc.dst.bedIds[1], status: 'requested', source_approved_at: null, destination_approved_at: null })
    const told = await notes(r.data.id)
    expect(told.filter(n => n.to_role === 'AA').map(n => n.site_id).sort()).toEqual([sc.src.siteId, sc.dst.siteId].sort())
    const a = await auditRows(r.data.id)
    expect(a.map(x => x.action)).toEqual(['stays.transfer.requested', 'stays.transfer.requested_cross_site'])
    expect(a[0].after).toMatchObject({ fromSiteId: sc.src.siteId, toSiteId: sc.dst.siteId, crossSite: true })
    const rows = (await admin().query(`SELECT site_id FROM audit_event WHERE entity_id = $1 ORDER BY seq`, [r.data.id])).rows
    expect(rows.map(x => x.site_id)).toEqual([sc.src.siteId, sc.dst.siteId])
  })

  it('"any suitable bed" in another site: only the site is named, the destination site\'s admin will pick the bed', async () => {
    const sc = await cross()
    const r = await requestTransfer(sc.res.rc, xreq(sc.stayId, null, sc.dst.siteId))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(await transferRow(r.data.id)).toMatchObject({ to_bed_id: null, destination_site_id: sc.dst.siteId })
  })

  it('an Accommodation Admin of the source site may raise it for a resident; the destination site\'s admin alone may not (the source site is theirs)', async () => {
    const sc = await cross()
    const ok = await requestTransfer(sc.src.aa.rc, xreq(sc.stayId, sc.dst.bedIds[1]))
    expect(ok.ok).toBe(true)
    const sc2 = await cross()
    const wrongSide = await requestTransfer(sc2.dst.aa.rc, xreq(sc2.stayId, sc2.dst.bedIds[1]))
    expect(!wrongSide.ok && wrongSide.code).toBe('not_found')
    const third = await requestTransfer(sc2.third.aa.rc, xreq(sc2.stayId, sc2.dst.bedIds[1]))
    expect(!third.ok && third.code).toBe('not_found')
  })

  it('refuses a site that is archived or unknown, a bed that is not in the named site, and the bed the person is already in', async () => {
    const sc = await cross()
    await admin().query(`UPDATE site SET archived_at = now() WHERE id = $1`, [sc.third.siteId])
    const archived = await requestTransfer(sc.res.rc, xreq(sc.stayId, null, sc.third.siteId))
    expect(!archived.ok && archived.detail).toMatchObject({ reason: 'site_archived' })
    const unknown = await requestTransfer(sc.res.rc, xreq(sc.stayId, null, '00000000-0000-4000-8000-000000000000'))
    expect(!unknown.ok && unknown.code).toBe('invalid')
    const mismatch = await requestTransfer(sc.res.rc, xreq(sc.stayId, sc.dst.bedIds[1], sc.src.siteId))
    expect(!mismatch.ok && mismatch.fields).toMatchObject({ destinationBedId: expect.any(String) })
    const same = await requestTransfer(sc.res.rc, xreq(sc.stayId, sc.src.bedIds[0]))
    expect(!same.ok && same.code).toBe('invalid')
    expect((await admin().query(`SELECT 1 FROM transfer_request WHERE stay_id = $1`, [sc.stayId])).rowCount).toBe(0)
  })

  it('a resident cannot request for somebody else\'s stay, in any direction', async () => {
    const sc = await cross()
    const [stranger] = await residents(1)
    const r = await requestTransfer(stranger.rc, xreq(sc.stayId, sc.dst.bedIds[1]))
    expect(!r.ok && r.code).toBe('not_found')
  })
})

describe('two keys: the Accommodation Admin of each site (D-104)', () => {
  it('the source site\'s admin alone cannot complete it: the request stays open, Reception is told what is missing and who owns it', async () => {
    const sc = await cross()
    const id = await requested(sc)
    const a = await approveTransfer(sc.src.aa.rc, { id, destinationBedId: null, ...noteBase })
    expect(a.ok && a.data).toMatchObject({ status: 'requested', keys: { source: true, destination: false } })
    expect(a.ok && a.data.waitingFor).toContain(sc.dst.name)
    const t = await transferRow(id)
    expect(t).toMatchObject({ status: 'requested', decided_at: null, source_approved_by: sc.src.aa.userId })
    expect(t.destination_approved_at).toBeNull()

    const early = await executeTransfer(sc.src.rec.rc, { id })
    expect(early.ok).toBe(false)
    if (!early.ok) {
      expect(early.reason).toMatch(/waiting for approval/)
      expect(early.reason).toContain(`Accommodation Admin of ${sc.dst.name}`)
      expect(early.reason).not.toContain(`Accommodation Admin of ${sc.src.name}`)
      expect(early.owner).toContain(sc.dst.name)
      expect(early.next).toMatch(/both sites/)
    }
    expect((await stayRow(sc.stayId)).bed_id).toBe(sc.src.bedIds[0])
    // the destination site's admin is told that the other site has said yes
    expect((await notes(id)).some(n => n.kind === 'transfer.half_approved' && n.to_role === 'AA' && n.site_id === sc.dst.siteId)).toBe(true)
  })

  it('the destination site\'s admin alone cannot complete it either, and names the source site as the one still to decide', async () => {
    const sc = await cross()
    const id = await requested(sc, null)
    const b = await approveTransfer(sc.dst.aa.rc, { id, destinationBedId: sc.dst.bedIds[2], ...noteBase })
    expect(b.ok && b.data).toMatchObject({ status: 'requested', keys: { source: false, destination: true } })
    expect(await transferRow(id)).toMatchObject({ to_bed_id: sc.dst.bedIds[2], status: 'requested' })
    const early = await executeTransfer(sc.dst.rec.rc, { id })
    expect(early.ok).toBe(false)
    if (!early.ok) { expect(early.reason).toContain(`Accommodation Admin of ${sc.src.name}`); expect(early.owner).toContain(sc.src.name) }
    // a Reception of the source site gets the same answer
    const early2 = await executeTransfer(sc.src.rec.rc, { id })
    expect(early2.ok).toBe(false)
  })

  it('with both keys it is approved; the last key is the decision; every key is audited at the site that gave it', async () => {
    const sc = await cross()
    const id = await requested(sc)
    await approveTransfer(sc.src.aa.rc, { id, destinationBedId: null, ...noteBase })
    const last = await approveTransfer(sc.dst.aa.rc, { id, destinationBedId: null, ...noteBase })
    expect(last.ok && last.data).toMatchObject({ status: 'approved', keys: { source: true, destination: true }, waitingFor: null })
    const t = await transferRow(id)
    expect(t).toMatchObject({ status: 'approved', decided_by: sc.dst.aa.userId, source_approved_by: sc.src.aa.userId, destination_approved_by: sc.dst.aa.userId })
    const rows = (await admin().query<{ action: string; site_id: string }>(`SELECT action, site_id FROM audit_event WHERE entity_id = $1 AND action LIKE 'stays.transfer.approved%' ORDER BY seq`, [id])).rows
    expect(rows).toEqual([
      { action: 'stays.transfer.approved_source', site_id: sc.src.siteId },
      { action: 'stays.transfer.approved_destination', site_id: sc.dst.siteId },
      { action: 'stays.transfer.approved', site_id: sc.src.siteId },
    ])
    // Reception of both sites is told it is ready
    const told = (await notes(id)).filter(n => n.kind === 'transfer.approved' && n.to_role === 'Rec')
    expect(told.map(n => n.site_id).sort()).toEqual([sc.src.siteId, sc.dst.siteId].sort())
  })

  it('the same admin cannot give the same key twice; they are told what is still missing and who owns it', async () => {
    const sc = await cross()
    const id = await requested(sc)
    await approveTransfer(sc.src.aa.rc, { id, destinationBedId: null, ...noteBase })
    const again = await approveTransfer(sc.srcAa2.rc, { id, destinationBedId: null, ...noteBase })
    expect(!again.ok && again.detail).toMatchObject({ reason: 'already_approved_by_you' })
    if (!again.ok) { expect(again.reason).toContain(sc.dst.name); expect(again.owner).toContain(sc.dst.name) }
  })

  it('one person who holds BOTH sites gives both keys in one decision', async () => {
    const sc = await cross()
    const both = await person('AA', { siteIds: [sc.src.siteId, sc.dst.siteId] })
    const id = await requested(sc)
    const r = await approveTransfer(both.rc, { id, destinationBedId: null, ...noteBase })
    expect(r.ok && r.data).toMatchObject({ status: 'approved', keys: { source: true, destination: true } })
    expect(await transferRow(id)).toMatchObject({ source_approved_by: both.userId, destination_approved_by: both.userId })
    expect((await executeTransfer(sc.src.rec.rc, { id })).ok).toBe(true)
  })

  it('only the destination site\'s admin chooses the bed there; the source site\'s admin cannot, and an "any suitable bed" request needs the choice', async () => {
    const sc = await cross()
    const id = await requested(sc, null)
    const meddling = await approveTransfer(sc.src.aa.rc, { id, destinationBedId: sc.dst.bedIds[1], ...noteBase })
    expect(!meddling.ok && meddling.detail).toMatchObject({ reason: 'bed_chosen_by_destination' })
    expect((await transferRow(id)).source_approved_at).toBeNull() // refused: no key was given
    expect((await approveTransfer(sc.src.aa.rc, { id, destinationBedId: null, ...noteBase })).ok).toBe(true)
    const none = await approveTransfer(sc.dst.aa.rc, { id, destinationBedId: null, ...noteBase })
    expect(!none.ok && none.code).toBe('invalid')
    const wrongSite = await approveTransfer(sc.dst.aa.rc, { id, destinationBedId: sc.src.bedIds[1], ...noteBase })
    expect(!wrongSite.ok && wrongSite.detail).toMatchObject({ reason: 'wrong_site' })
    const ok = await approveTransfer(sc.dst.aa.rc, { id, destinationBedId: sc.dst.bedIds[2], ...noteBase })
    expect(ok.ok && ok.data.status).toBe('approved')
    expect((await transferRow(id)).to_bed_id).toBe(sc.dst.bedIds[2])
  })

  it('an Accommodation Admin of a THIRD site gets "not found" on approve, reject, cancel and execute', async () => {
    const sc = await cross()
    const id = await requested(sc)
    for (const r of [
      await approveTransfer(sc.third.aa.rc, { id, destinationBedId: null, ...noteBase }),
      await rejectTransfer(sc.third.aa.rc, { id, reason: 'not mine to refuse' }),
      await cancelRequest(sc.third.aa.rc, { kind: 'transfer', id, note: null }),
      await executeTransfer(sc.third.rec.rc, { id }),
    ]) expect(!r.ok && r.code).toBe('not_found')
    expect((await transferRow(id)).status).toBe('requested')
    // and the list never shows it to them
    expect((await listTransfers(sc.third.aa.rc.actor)).map(t => t.id)).not.toContain(id)
  })

  it('separation of duties (D-109, D-26): nobody approves what they raised or are part of, on either side', async () => {
    const sc = await cross()
    const raised = await requestTransfer(sc.src.aa.rc, xreq(sc.stayId, sc.dst.bedIds[1]))
    if (!raised.ok) throw new Error('setup')
    const id = raised.data.id
    expect((await approveTransfer(sc.src.aa.rc, { id, destinationBedId: null, ...noteBase })))
      .toMatchObject({ ok: false, code: 'separation_of_duties' })
    // the raiser who ALSO holds the destination site
    const dual = as(sc.src.aa, 'AA', { siteIds: [sc.src.siteId, sc.dst.siteId] })
    expect(await approveTransfer(dual.rc, { id, destinationBedId: sc.dst.bedIds[1], ...noteBase })).toMatchObject({ ok: false, code: 'separation_of_duties' })
    // the resident, signed in as an admin of the destination site
    const self = as({ ...sc.res }, 'AA', { siteIds: [sc.dst.siteId] })
    expect(await approveTransfer(self.rc, { id, destinationBedId: sc.dst.bedIds[1], ...noteBase })).toMatchObject({ ok: false, code: 'separation_of_duties' })
    expect(await rejectTransfer(self.rc, { id, reason: 'I changed my mind' })).toMatchObject({ ok: false, code: 'separation_of_duties' })
    expect(await transferRow(id)).toMatchObject({ status: 'requested', source_approved_at: null, destination_approved_at: null })
    // independent admins of each site can
    expect((await approveTransfer(sc.srcAa2.rc, { id, destinationBedId: null, ...noteBase })).ok).toBe(true)
    expect((await approveTransfer(sc.dstAa2.rc, { id, destinationBedId: null, ...noteBase })).ok).toBe(true)
  })

  it('either site can refuse (one "no" ends it), with a reason; nobody moves; the audit row sits at the refusing site', async () => {
    const sc = await cross()
    const id = await requested(sc)
    await approveTransfer(sc.src.aa.rc, { id, destinationBedId: null, ...noteBase })
    const no = await rejectTransfer(sc.dst.aa.rc, { id, reason: 'No ready bed for a month' })
    expect(no.ok).toBe(true)
    expect(await transferRow(id)).toMatchObject({ status: 'rejected' })
    expect((await stayRow(sc.stayId)).bed_id).toBe(sc.src.bedIds[0])
    const rej = (await admin().query<{ site_id: string; after: any }>(`SELECT site_id, after FROM audit_event WHERE entity_id = $1 AND action = 'stays.transfer.rejected'`, [id])).rows[0]
    expect(rej.site_id).toBe(sc.dst.siteId)
    expect(rej.after).toMatchObject({ rejectedAt: 'destination', fromSiteId: sc.src.siteId, toSiteId: sc.dst.siteId })
  })

  it('an Accommodation Admin of either site may withdraw it; the resident too', async () => {
    const sc = await cross()
    const id = await requested(sc)
    expect((await cancelRequest(sc.dst.aa.rc, { kind: 'transfer', id, note: null })).ok).toBe(true)
    const sc2 = await cross()
    const id2 = await requested(sc2)
    expect((await cancelRequest(sc2.res.rc, { kind: 'transfer', id: id2, note: null })).ok).toBe(true)
  })

  it('backup rule per site (APPROVALS.md): a Policy Approver of the destination site may give that key only once the SLA clock has routed it to the backup; they have no part at the other site', async () => {
    const sc = await cross()
    const id = await requested(sc)
    const pa = await person('Rec', { siteIds: [sc.dst.siteId], caps: ['PolicyApprover'] })
    const early = await approveTransfer(pa.rc, { id, destinationBedId: sc.dst.bedIds[1], ...noteBase })
    expect(!early.ok && early.code).toBe('forbidden')
    if (!early.ok) expect(early.reason).toMatch(/waiting for the Accommodation Admin/)
    const later = as(pa, 'Rec', { siteIds: [sc.dst.siteId], caps: ['PolicyApprover'], clock: new FixedClock(NOW + 7 * DAY_MS) })
    const ok = await approveTransfer(later.rc, { id, destinationBedId: sc.dst.bedIds[1], ...noteBase })
    expect(ok.ok && ok.data).toMatchObject({ keys: { source: false, destination: true } })
    // the grant at the destination site says nothing about the source site
    const outOfScope = await approveTransfer(later.rc, { id, destinationBedId: null, ...noteBase })
    expect(!outOfScope.ok).toBe(true)
    expect((await transferRow(id)).source_approved_at).toBeNull()
  })
})

describe('execution across sites (D-104, D-61)', () => {
  it('moves the resident: the destination is allocated first, the source released, the stay belongs to the new site, the old bed needs cleaning', async () => {
    const sc = await cross()
    const id = await requested(sc)
    await approvedByBoth(sc, id)
    const out = await executeTransfer(sc.src.rec.rc, { id })
    expect(out.ok).toBe(true)
    const s = await stayRow(sc.stayId)
    expect(s.bed_id).toBe(sc.dst.bedIds[1])
    expect(s.status).toBe('active')
    expect(await bedState(sc.dst.bedIds[1])).toBe('occupied')
    expect(await bedState(sc.src.bedIds[0])).toBe('needs_cleaning')
    expect((await claimRow(sc.claimId)).release_reason).toBe('transferred')
    expect(await liveClaims(sc.dst.bedIds[1])).toMatchObject([{ id: s.claim_id, kind: 'stay', period: `[${day(0)},${day(30)})` }])
    expect(await liveClaims(sc.src.bedIds[0])).toHaveLength(0)
    // exactly one cleaning task for the bed that was left, in the SOURCE site
    expect((await admin().query(`SELECT site_id, status FROM cleaning_task WHERE bed_id = $1`, [sc.src.bedIds[0]])).rows).toEqual([{ site_id: sc.src.siteId, status: 'open' }])
    expect(await transferRow(id)).toMatchObject({ status: 'executed', executed_by: sc.src.rec.userId })
  })

  it('Reception or an admin of EITHER site may carry it out (the DEFAULT of D-104), a third site\'s Reception may not, and the person it is about may not', async () => {
    const sc = await cross()
    const id = await requested(sc)
    await approvedByBoth(sc, id)
    const third = await executeTransfer(sc.third.rec.rc, { id })
    expect(!third.ok && third.code).toBe('not_found')
    const involved = as({ ...sc.res }, 'Rec', { siteIds: [sc.src.siteId, sc.dst.siteId] })
    expect(await executeTransfer(involved.rc, { id })).toMatchObject({ ok: false, code: 'separation_of_duties' })
    expect((await executeTransfer(sc.dst.rec.rc, { id })).ok).toBe(true) // the destination site's Reception

    const sc2 = await cross()
    const id2 = await requested(sc2)
    await approvedByBoth(sc2, id2)
    expect((await executeTransfer(sc2.srcAa2.rc, { id: id2 })).ok).toBe(true) // an Accommodation Admin of the source site
  })

  it('after the move the stay is the NEW site\'s: scope, queries and audit all use it (the old site\'s admin no longer sees it, the new site\'s does)', async () => {
    const sc = await cross()
    const id = await requested(sc)
    await approvedByBoth(sc, id)
    const now = new Date(NOW)
    expect((await listStays(sc.src.aa.rc.actor, {}, now)).rows.map(r => r.id)).toContain(sc.stayId)
    expect((await listStays(sc.dst.aa.rc.actor, {}, now)).rows.map(r => r.id)).not.toContain(sc.stayId) // not yet: still in the source site
    expect((await executeTransfer(sc.src.rec.rc, { id })).ok).toBe(true)

    expect((await listStays(sc.src.aa.rc.actor, {}, now)).rows.map(r => r.id)).not.toContain(sc.stayId)
    expect((await listStays(sc.dst.aa.rc.actor, {}, now)).rows.map(r => r.id)).toContain(sc.stayId)
    expect(await getStayDetail(sc.src.aa.rc.actor, sc.stayId, now)).toBeUndefined()
    const detail = await getStayDetail(sc.dst.aa.rc.actor, sc.stayId, now)
    expect(detail).toMatchObject({ siteId: sc.dst.siteId, siteName: sc.dst.name })
    expect(detail?.transfers[0]).toMatchObject({ crossSite: true, fromSiteName: sc.src.name, toSiteName: sc.dst.name })
    // commands use the new site for scope too: the old site's admin is "not found", the new site's can act
    const e1 = await requestExtension(sc.srcAa2.rc, { stayId: sc.stayId, newEnd: day(36), reason: 'Project extended' })
    expect(!e1.ok && e1.code).toBe('not_found')
    const e2 = await requestExtension(sc.dstAa2.rc, { stayId: sc.stayId, newEnd: day(36), reason: 'Project extended' })
    expect(e2.ok).toBe(true)
    expect(e2.ok && (await admin().query(`SELECT site_id FROM extension_request WHERE id = $1`, [e2.data.id])).rows[0].site_id).toBe(sc.dst.siteId)
    // the transfer itself stays visible to both sites (history), and to the resident
    for (const p of [sc.src.aa, sc.dst.aa, sc.res]) expect((await listTransfers(p.rc.actor, {}, now)).map(t => t.id)).toContain(id)
    // the resident's own view: the stay is in the new site
    expect((await listStays(sc.res.rc.actor, { staffId: sc.res.staffId }, now)).rows[0]).toMatchObject({ siteId: sc.dst.siteId, bedId: sc.dst.bedIds[1] })
  })

  it('audit rows for the move carry BOTH site ids: the request event at each site, the stay event at the new site and at the old one', async () => {
    const sc = await cross()
    const id = await requested(sc)
    await approvedByBoth(sc, id)
    expect((await executeTransfer(sc.src.rec.rc, { id })).ok).toBe(true)
    const both = { fromSiteId: sc.src.siteId, toSiteId: sc.dst.siteId }
    const t = (await admin().query<{ action: string; site_id: string; after: any }>(`SELECT action, site_id, after FROM audit_event WHERE entity_id = $1 AND action IN ('stays.transfer.executed', 'stays.transfer.received') ORDER BY seq`, [id])).rows
    expect(t.map(x => [x.action, x.site_id])).toEqual([['stays.transfer.executed', sc.src.siteId], ['stays.transfer.received', sc.dst.siteId]])
    for (const x of t) { expect(x.after).toMatchObject(both); expect(x.after.keysReturned).toMatch(/Stage 3/) }
    const s = (await admin().query<{ action: string; site_id: string; after: any }>(`SELECT action, site_id, after FROM audit_event WHERE entity_id = $1 AND action LIKE 'stays.stay.%' ORDER BY seq`, [sc.stayId])).rows
    expect(s.map(x => [x.action, x.site_id])).toEqual([['stays.stay.moved', sc.dst.siteId], ['stays.stay.left_site', sc.src.siteId]])
    for (const x of s) expect(x.after).toMatchObject({ ...both, transferId: id })
    // everybody concerned was told
    const told = await notes(id)
    expect(told.some(n => n.kind === 'transfer.executed' && n.to_role === 'AA' && n.site_id === sc.dst.siteId)).toBe(true)
    // the destination site's Reception is told to issue the keys (that note points at the stay)
    expect((await notes(sc.stayId)).some(n => n.kind === 'transfer.executed' && n.to_role === 'Rec' && n.site_id === sc.dst.siteId)).toBe(true)
  })

  it('a second Accommodation Admin of the same site is not needed once the independent ones have approved: execution is a separate step by Reception', async () => {
    const sc = await cross()
    const id = await requested(sc)
    await approvedByBoth(sc, id)
    expect((await transferRow(id)).status).toBe('approved')
    expect((await stayRow(sc.stayId)).bed_id).toBe(sc.src.bedIds[0]) // approval moves nobody
  })
})

describe('incompatible future bookings (SRS 5.5 step 27)', () => {
  it('nothing dangles after a move: no live reservation, no pending offer, no open waitlist entry, exactly one live claim for the person', async () => {
    const sc = await cross()
    const id = await requested(sc)
    await approvedByBoth(sc, id)
    expect((await executeTransfer(sc.src.rec.rc, { id })).ok).toBe(true)
    const q = async (sql: string) => (await admin().query(sql, [sc.res.staffId])).rows
    expect(await q(`SELECT 1 FROM reservation WHERE staff_id = $1 AND status = 'reserved'`)).toHaveLength(0)
    expect(await q(`SELECT 1 FROM bed_offer WHERE staff_id = $1 AND status = 'pending'`)).toHaveLength(0)
    expect(await q(`SELECT 1 FROM waitlist_entry WHERE staff_id = $1 AND status <> 'closed'`)).toHaveLength(0)
    expect(await q(`SELECT c.id FROM bed_claim c JOIN stay s ON s.claim_id = c.id WHERE s.staff_id = $1 AND c.released_at IS NULL`)).toHaveLength(1)
    // the audit row says what the follow-ups did
    const ex = (await auditRows(id)).find(a => a.action === 'stays.transfer.executed')!
    expect(ex.after.followUps).toMatchObject({ stay_requests: { extensionsRerouted: 0, checkoutsRerouted: 0 }, future_bookings: { reservationsCancelled: 0, waitlistEntriesClosed: 0, offersWithdrawn: 0 } })
  })

  it('should one exist anyway (a stray reservation, an open waitlist entry with a pending offer) it is cancelled, closed and withdrawn in the same transaction, the holds are released, and the person is told', async () => {
    const sc = await cross()
    const spare = await namedSpare(sc)
    // a future reservation for the same person on another bed of the destination site
    const rv = await mkReservation({ bedId: spare.bed, staffId: sc.res.staffId, from: day(40), to: day(60) })
    // an open waitlist entry and a pending offer holding a bed of the source site
    const entry = (await admin().query<{ id: string }>(
      `INSERT INTO waitlist_entry (staff_id, site_id, expires_at, arrival_date, end_date, stay_type, status) VALUES ($1, $2, $3, $4, $5, 'contract', 'offered') RETURNING id`,
      [sc.res.staffId, sc.src.siteId, day(15), day(5), day(65)])).rows[0].id
    const hold = (await admin().query<{ id: string }>(`INSERT INTO bed_claim (bed_id, kind, period) VALUES ($1, 'offer_hold', $2::daterange) RETURNING id`, [sc.src.bedIds[2], `[${day(5)},${day(65)})`])).rows[0].id
    const offer = (await admin().query<{ id: string }>(
      `INSERT INTO bed_offer (staff_id, waitlist_entry_id, bed_id, claim_id, status) VALUES ($1, $2, $3, $4, 'pending') RETURNING id`, [sc.res.staffId, entry, sc.src.bedIds[2], hold])).rows[0].id

    const id = await requested(sc)
    await approvedByBoth(sc, id)
    expect((await executeTransfer(sc.src.rec.rc, { id })).ok).toBe(true)

    const why = /Moved to .+ by a transfer/
    expect(await rvStatus(rv.reservationId)).toMatchObject({ status: 'cancelled' })
    expect((await rvStatus(rv.reservationId)).cancel_reason).toMatch(why)
    expect((await claimRow(rv.claimId)).released_at).not.toBeNull()
    expect((await admin().query(`SELECT status, close_reason FROM waitlist_entry WHERE id = $1`, [entry])).rows[0]).toMatchObject({ status: 'closed' })
    expect((await admin().query(`SELECT status FROM bed_offer WHERE id = $1`, [offer])).rows[0].status).not.toBe('pending')
    expect((await claimRow(hold)).released_at).not.toBeNull()
    expect(await liveClaims(sc.src.bedIds[2])).toHaveLength(0)
    expect((await auditRows(rv.reservationId)).map(a => a.action)).toContain('stays.transfer.booking_cancelled')
    expect((await notifs(sc.res.staffId)).some(n => n.kind === 'reservation.cancelled')).toBe(true)
    const ex = (await auditRows(id)).find(a => a.action === 'stays.transfer.executed')!
    expect(ex.after.followUps.future_bookings).toMatchObject({ reservationsCancelled: 1, waitlistEntriesClosed: 1 })
  })

  it('an open extension or checkout request of the moved stay goes with the stay: it is handed to the new site\'s admin and Reception, and a stale clash note is dropped', async () => {
    const sc = await cross()
    const ext = await requestExtension(sc.res.rc, { stayId: sc.stayId, newEnd: day(36), reason: null })
    if (!ext.ok) throw new Error('setup: ' + ext.reason)
    await admin().query(`UPDATE extension_request SET clash = '{"reason":"next_booking"}'::jsonb WHERE id = $1`, [ext.data.id])
    const co = (await admin().query<{ id: string }>(`INSERT INTO checkout_request (site_id, stay_id, staff_id, departure_date) VALUES ($1, $2, $3, $4) RETURNING id`, [sc.src.siteId, sc.stayId, sc.res.staffId, day(25)])).rows[0].id
    const id = await requested(sc)
    await approvedByBoth(sc, id)
    expect((await executeTransfer(sc.src.rec.rc, { id })).ok).toBe(true)
    expect((await admin().query(`SELECT site_id, status, clash FROM extension_request WHERE id = $1`, [ext.data.id])).rows[0]).toEqual({ site_id: sc.dst.siteId, status: 'requested', clash: null })
    expect((await admin().query(`SELECT site_id, status FROM checkout_request WHERE id = $1`, [co])).rows[0]).toEqual({ site_id: sc.dst.siteId, status: 'requested' })
    expect((await auditRows(ext.data.id)).map(a => a.action)).toContain('stays.extension.rerouted')
    expect((await notes(ext.data.id)).some(n => n.kind === 'extension.rerouted' && n.site_id === sc.dst.siteId)).toBe(true)
  })

  it('the extension point: a registered follow-up runs inside the move, its result is audited, and if it throws the whole move rolls back and the resident stays put', async () => {
    expect(crossSiteFollowUpIds()).toEqual(expect.arrayContaining(['stay_requests', 'future_bookings']))
    registerCrossSiteFollowUp('test_passes', async (_c, m) => ({ passesChecked: 2, for: m.stayId }))
    const sc = await cross()
    const id = await requested(sc)
    await approvedByBoth(sc, id)
    expect((await executeTransfer(sc.src.rec.rc, { id })).ok).toBe(true)
    expect(((await auditRows(id)).find(a => a.action === 'stays.transfer.executed')!.after.followUps.test_passes)).toMatchObject({ passesChecked: 2, for: sc.stayId })

    const sc2 = await cross()
    const id2 = await requested(sc2)
    await approvedByBoth(sc2, id2)
    registerCrossSiteFollowUp(`test_fail_${id2}`, async (_c, m) => { if (m.transferId === id2) throw new Error('pass service unavailable'); return {} })
    const failed = await executeTransfer(sc2.src.rec.rc, { id: id2 })
    expect(!failed.ok && failed.code).toBe('internal')
    expect((await stayRow(sc2.stayId)).bed_id).toBe(sc2.src.bedIds[0])
    expect((await claimRow(sc2.claimId)).released_at).toBeNull()
    expect(await bedState(sc2.dst.bedIds[1])).toBe('available')
    expect(await liveClaims(sc2.dst.bedIds[1])).toHaveLength(0)
    expect((await transferRow(id2)).status).toBe('approved')
  })
})

describe('cross-site swap (D-62, D-104)', () => {
  it('needs both occupants\' consent and the approval of the Accommodation Admins of BOTH sites, then swaps both in one operation', async () => {
    const sc = await twoStays()
    const id = await swapRequested(sc)
    expect(await transferRow(id)).toMatchObject({ kind: 'swap', site_id: sc.src.siteId, destination_site_id: sc.dst.siteId })
    // the raiser (source site admin) cannot approve their own swap; the other source admin's key is not enough on its own
    expect(await approveTransfer(sc.src.aa.rc, { id, destinationBedId: null, ...noteBase })).toMatchObject({ ok: false, code: 'separation_of_duties' })
    const first = await approveTransfer(sc.srcAa2.rc, { id, destinationBedId: null, ...noteBase })
    expect(first.ok && first.data).toMatchObject({ status: 'requested', keys: { source: true, destination: false } })
    const early = await executeTransfer(sc.src.rec.rc, { id })
    expect(!early.ok && early.reason).toContain(`Accommodation Admin of ${sc.dst.name}`)
    expect((await approveTransfer(sc.dst.aa.rc, { id, destinationBedId: null, ...noteBase })).ok).toBe(true)

    const out = await executeTransfer(sc.dst.rec.rc, { id })
    expect(out.ok).toBe(true)
    const [a, b] = [await stayRow(sc.a.stayId), await stayRow(sc.b.stayId)]
    expect([a.bed_id, b.bed_id]).toEqual([sc.dst.bedIds[0], sc.src.bedIds[0]])
    expect(await bedState(sc.src.bedIds[0])).toBe('occupied')
    expect(await bedState(sc.dst.bedIds[0])).toBe('occupied')
    expect(await liveClaims(sc.dst.bedIds[0])).toMatchObject([{ id: a.claim_id, kind: 'stay', period: `[${day(0)},${day(30)})` }])
    expect(await liveClaims(sc.src.bedIds[0])).toMatchObject([{ id: b.claim_id, kind: 'stay', period: `[${day(0)},${day(40)})` }])
    const actions = (await admin().query<{ action: string; site_id: string }>(`SELECT action, site_id FROM audit_event WHERE entity_id = $1 AND action LIKE 'stays.swap.%executed' OR entity_id = $1 AND action = 'stays.swap.received' ORDER BY seq`, [id])).rows
    expect(actions.map(x => [x.action, x.site_id])).toEqual([['stays.swap.executed', sc.src.siteId], ['stays.swap.received', sc.dst.siteId]])
    // each stay now belongs to the other site
    const now = new Date(NOW)
    expect((await getStayDetail(sc.src.aa.rc.actor, sc.b.stayId, now))?.siteId).toBe(sc.src.siteId)
    expect(await getStayDetail(sc.src.aa.rc.actor, sc.a.stayId, now)).toBeUndefined()
  })

  it('consent is still required first, and an Accommodation Admin of either site may record it; a third site\'s admin may not raise or record', async () => {
    const sc = await twoStays()
    const third = await person('AA', { siteIds: [(await admin().query<{ id: string }>(`INSERT INTO site (code, name, kind) VALUES ($1, 'Third', 'apartment') RETURNING id`, ['T' + Math.random().toString(36).slice(2, 8)])).rows[0].id] })
    const raised = await requestSwap(third.rc, { stayId: sc.a.stayId, otherStayId: sc.b.stayId, reason: 'x', neededBy: null, consentFirst: null, consentSecond: null })
    expect(!raised.ok && raised.code).toBe('not_found')
    const r = await requestSwap(sc.src.aa.rc, { stayId: sc.a.stayId, otherStayId: sc.b.stayId, reason: 'x', neededBy: null, consentFirst: null, consentSecond: null })
    if (!r.ok) throw new Error('setup: ' + r.reason)
    const id = r.data.id
    expect(await approveTransfer(sc.srcAa2.rc, { id, destinationBedId: null, ...noteBase })).toMatchObject({ ok: false, detail: { reason: 'consent_missing' } })
    expect((await recordSwapConsent(third.rc, { id, party: 'a', via: 'phone', note: null })).ok).toBe(false)
    expect((await recordSwapConsent(sc.dst.aa.rc, { id, party: 'b', via: 'phone', note: null })).ok).toBe(true) // the other site's admin records the occupant of THEIR site
    expect((await recordSwapConsent(sc.ra.rc, { id, party: null, via: null, note: null })).ok).toBe(true)
    expect((await approveTransfer(sc.srcAa2.rc, { id, destinationBedId: null, ...noteBase })).ok).toBe(true)
  })

  it('a swap is refused up front when one of the two would not be eligible at the other site', async () => {
    const sc = await twoStays()
    await admin().query(`UPDATE staff_profile SET gender = 'male' WHERE id = $1`, [sc.ra.staffId])
    await admin().query(`UPDATE room SET gender_policy = 'female' WHERE site_id = $1`, [sc.dst.siteId])
    const c = { via: 'in_person' as const, note: null }
    const r = await requestSwap(sc.src.aa.rc, { stayId: sc.a.stayId, otherStayId: sc.b.stayId, reason: 'x', neededBy: null, consentFirst: c, consentSecond: c })
    expect(!r.ok && r.detail).toMatchObject({ reason: 'not_eligible' })
    expect((await admin().query(`SELECT 1 FROM transfer_request WHERE stay_id = $1`, [sc.a.stayId])).rowCount).toBe(0)
  })
})

/* ---------------- small helpers ---------------- */

async function namedSpare(sc: Awaited<ReturnType<typeof cross>>) {
  const room = (await admin().query<{ id: string }>(`INSERT INTO room (site_id, name) VALUES ($1, 'Spare') RETURNING id`, [sc.dst.siteId])).rows[0].id
  const bed = (await admin().query<{ id: string }>(`INSERT INTO bed (site_id, room_id, code) VALUES ($1, $2, 'SPARE') RETURNING id`, [sc.dst.siteId, room])).rows[0].id
  return { room, bed }
}
const rvStatus = async (id: string) => (await admin().query<{ status: string; cancel_reason: string | null }>(`SELECT status, cancel_reason FROM reservation WHERE id = $1`, [id])).rows[0]
const notifs = async (staffId: string) => (await admin().query<{ kind: string }>(`SELECT kind FROM notification WHERE to_staff_id = $1`, [staffId])).rows

// referenced to keep the helper module's exports used in this file
void [nameOfSite, setBedState, newClock, mkStay]
