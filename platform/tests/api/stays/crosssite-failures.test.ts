/**
 * D-104 / AT-022 across sites: the destination is judged AT THE DESTINATION SITE (its eligibility rules, its beds' readiness), and
 * whenever the move cannot be completed the resident stays exactly where they were: stay, source claim, both bed states, with the
 * failure recorded and both sites' admins told. Same-site behaviour is asserted unchanged at the end.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { admin, closeAll } from '../harness'
import {
  auditRows, bedState, claimRow, day, liveClaims, mkReservation, residents, setBedState, setConfigValue, stayRow, transferRow, mkStay, person, world,
} from './helpers'
import { mkException } from '../fixtures2'
import { approveTransfer } from '@/server/commands/stays/decideTransfer'
import { executeTransfer } from '@/server/commands/stays/executeTransfer'
import { requestSwap, requestTransfer } from '@/server/commands/stays/requestTransfer'
import { approvedByBoth, cross, requested, swapRequested, twoStays, xreq, type Cross } from './crossHelpers'

afterAll(closeAll)
const none = { note: null }

/** Everything about the resident that must be exactly as before a failed move. */
async function snapshot(sc: Cross, dest: string) {
  return {
    stay: await stayRow(sc.stayId),
    claim: await claimRow(sc.claimId),
    source: await bedState(sc.src.bedIds[0]),
    dest: await bedState(dest),
    sourceClaims: (await liveClaims(sc.src.bedIds[0])).map(c => c.id),
    destClaims: (await liveClaims(dest)).map(c => c.id),
    stayAudit: (await auditRows(sc.stayId)).length,
    cleaning: (await admin().query(`SELECT 1 FROM cleaning_task WHERE bed_id = $1`, [sc.src.bedIds[0]])).rowCount,
  }
}

describe('AT-022 across sites: a destination that became unavailable fails safely', () => {
  const cases: [string, (sc: Cross, dest: string) => Promise<void>, string][] = [
    ['the destination bed was blocked after both approvals', async (_sc, dest) => setBedState(dest, 'blocked'), 'bed_unavailable'],
    ['the destination bed was reserved by someone else after approval', async (_sc, dest) => { await mkReservation({ bedId: dest, staffId: (await residents(1))[0].staffId, from: day(2), to: day(9) }) }, 'bed_taken'],
    ['the destination bed needs cleaning (not ready)', async (_sc, dest) => setBedState(dest, 'needs_cleaning'), 'bed_not_ready'],
    ['the destination bed is held by a bed offer', async (_sc, dest) => {
      await admin().query(`INSERT INTO bed_claim (bed_id, kind, period) VALUES ($1, 'offer_hold', $2::daterange)`, [dest, `[${day(1)},${day(60)})`])
    }, 'bed_held'],
  ]
  for (const [name, breakIt, reason] of cases) {
    it(`${name}: nothing moves, the request is marked failed, BOTH sites' admins are told, and only the destination key has to be given again`, async () => {
      const sc = await cross()
      const dest = sc.dst.bedIds[1]
      const id = await requested(sc)
      await approvedByBoth(sc, id)
      await breakIt(sc, dest)
      const before = await snapshot(sc, dest)

      const out = await executeTransfer(sc.src.rec.rc, { id })
      expect(out.ok).toBe(false)
      if (out.ok) return
      expect(out.code).toBe('conflict')
      expect(out.detail).toMatchObject({ reason, executionFailed: true })
      expect(out.owner).toBeTruthy()
      expect(out.next).toBeTruthy()

      expect(await snapshot(sc, dest)).toEqual(before)
      expect((await claimRow(sc.claimId)).released_at).toBeNull()

      const t = await transferRow(id)
      expect(t).toMatchObject({ status: 'failed', failure_count: 1, executed_at: null, new_claim_id: null, destination_approved_at: null })
      expect(t.failure_reason).toBe(out.reason)
      expect(t.source_approved_at).not.toBeNull() // the source site's yes still stands
      const failedAudit = (await admin().query<{ site_id: string }>(`SELECT site_id FROM audit_event WHERE entity_id = $1 AND action = 'stays.transfer.failed'`, [id])).rows
      expect(failedAudit.map(r => r.site_id).sort()).toEqual([sc.src.siteId, sc.dst.siteId].sort())
      expect((await auditRows(id)).map(a => a.action)).not.toContain('stays.transfer.executed')
      const told = (await admin().query<{ site_id: string; critical: boolean; text: string }>(`SELECT site_id, critical, text FROM notification WHERE ref_id = $1 AND kind = 'transfer.failed' AND to_role = 'AA'`, [id])).rows
      expect(told.map(n => n.site_id).sort()).toEqual([sc.src.siteId, sc.dst.siteId].sort())
      expect(told.every(n => n.critical && /nobody was moved/.test(n.text))).toBe(true)

      // it cannot be carried out as it is; the destination site's admin chooses another bed and approves again; the source key is not asked again
      const again = await executeTransfer(sc.src.rec.rc, { id })
      expect(!again.ok && again.reason).toMatch(/failed the last time/)
      expect(!again.ok && again.owner).toContain(sc.dst.name)
      const srcAgain = await approveTransfer(sc.src.aa.rc, { id, destinationBedId: null, ...none })
      expect(!srcAgain.ok && srcAgain.detail).toMatchObject({ reason: 'already_approved_by_you' })
      const re = await approveTransfer(sc.dst.aa.rc, { id, destinationBedId: sc.dst.bedIds[2], ...none })
      expect(re.ok && re.data.status).toBe('approved')
      expect((await executeTransfer(sc.dst.rec.rc, { id })).ok).toBe(true)
      expect((await stayRow(sc.stayId)).bed_id).toBe(sc.dst.bedIds[2])
    })
  }

  it('the suggestions that come with the failure are beds of the DESTINATION site', async () => {
    const sc = await cross()
    const id = await requested(sc)
    await approvedByBoth(sc, id)
    await mkReservation({ bedId: sc.dst.bedIds[1], staffId: (await residents(1))[0].staffId, from: day(2), to: day(9) })
    const out = await executeTransfer(sc.src.rec.rc, { id })
    expect(out.ok).toBe(false)
    const sugg = (await transferRow(id)).failure_detail.suggestions as { bedId: string }[]
    expect(sugg.length).toBeGreaterThan(0)
    const sites = (await admin().query<{ site_id: string }>(`SELECT site_id FROM bed WHERE id = ANY($1::uuid[])`, [sugg.map(s => s.bedId)])).rows.map(r => r.site_id)
    expect(new Set(sites)).toEqual(new Set([sc.dst.siteId]))
  })

  it('the destination site was archived after approval: fails safely with the reason', async () => {
    const sc = await cross()
    const id = await requested(sc)
    await approvedByBoth(sc, id)
    const before = await snapshot(sc, sc.dst.bedIds[1])
    await admin().query(`UPDATE site SET archived_at = now() WHERE id = $1`, [sc.dst.siteId])
    const out = await executeTransfer(sc.src.rec.rc, { id })
    expect(!out.ok && out.detail).toMatchObject({ reason: 'site_archived', executionFailed: true })
    expect(await snapshot(sc, sc.dst.bedIds[1])).toEqual(before)
    expect((await transferRow(id)).status).toBe('failed')
  })

  it('the stay ended or moved since approval: stale, nothing changes', async () => {
    const sc = await cross()
    const id = await requested(sc)
    await approvedByBoth(sc, id)
    await admin().query(`UPDATE stay SET status = 'checked_out', checked_out_at = now() WHERE id = $1`, [sc.stayId])
    const out = await executeTransfer(sc.src.rec.rc, { id })
    expect(!out.ok && out.detail).toMatchObject({ reason: 'stale' })
    expect(await bedState(sc.dst.bedIds[1])).toBe('available')
    expect((await transferRow(id)).status).toBe('failed')
  })
})

describe('the destination site\'s rules apply at the destination (D-104)', () => {
  it('gender: a male resident cannot take a female-only room of the other site; the refusal names the Policy Approver route and nothing is stored', async () => {
    const sc = await cross()
    await admin().query(`UPDATE staff_profile SET gender = 'male' WHERE id = $1`, [sc.res.staffId])
    await admin().query(`UPDATE room SET gender_policy = 'female' WHERE site_id = $1`, [sc.dst.siteId])
    const r = await requestTransfer(sc.res.rc, xreq(sc.stayId, sc.dst.bedIds[1]))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('conflict')
    expect(r.detail).toMatchObject({ reason: 'not_eligible', exceptionable: true })
    expect(r.reason).toMatch(/female-only/)
    expect(r.owner).toBe('Policy Approver')
    expect(r.next).toMatch(/exception/)
    expect((await admin().query(`SELECT 1 FROM transfer_request WHERE stay_id = $1`, [sc.stayId])).rowCount).toBe(0)
  })

  it('a Policy Approver exception for that person and site lets it through, and its use is recorded against the transfer', async () => {
    const sc = await cross()
    await admin().query(`UPDATE staff_profile SET gender = 'male' WHERE id = $1`, [sc.res.staffId])
    await admin().query(`UPDATE room SET gender_policy = 'female' WHERE site_id = $1`, [sc.dst.siteId])
    const exceptionId = await mkException({ staffId: sc.res.staffId, kind: 'gender', grantedBy: sc.dst.aa.userId, siteId: sc.dst.siteId })
    const id = await requested(sc)
    await approvedByBoth(sc, id)
    expect((await executeTransfer(sc.src.rec.rc, { id })).ok).toBe(true)
    const uses = (await admin().query<{ used_for: string; used_ref: string }>(`SELECT used_for, used_ref FROM eligibility_exception_use WHERE exception_id = $1`, [exceptionId])).rows
    expect(uses).toEqual([{ used_for: 'transfer', used_ref: id }])
  })

  it('grade: the DESTINATION site\'s minimum grade is what counts, not the source site\'s', async () => {
    const sc = await cross()
    await admin().query(`UPDATE staff_profile SET grade = 5 WHERE id = $1`, [sc.res.staffId])
    await setConfigValue('eligibility.min_grade', 6, sc.dst.siteId)
    const refused = await requestTransfer(sc.res.rc, xreq(sc.stayId, sc.dst.bedIds[1]))
    expect(!refused.ok && refused.detail).toMatchObject({ reason: 'not_eligible', failed: ['grade'] })
    expect(!refused.ok && refused.reason).toMatch(/needs grade 6\+/)
    // the other way round: a strict SOURCE site does not hold the person back from a destination without that rule
    const sc2 = await cross()
    await admin().query(`UPDATE staff_profile SET grade = 5 WHERE id = $1`, [sc2.res.staffId])
    await setConfigValue('eligibility.min_grade', 9, sc2.src.siteId)
    expect((await requestTransfer(sc2.res.rc, xreq(sc2.stayId, sc2.dst.bedIds[1]))).ok).toBe(true)
  })

  it('"any suitable bed": the destination admin cannot approve a bed the person is not eligible for there', async () => {
    const sc = await cross()
    await admin().query(`UPDATE staff_profile SET gender = 'male' WHERE id = $1`, [sc.res.staffId])
    const id = await requested(sc, null)
    await admin().query(`UPDATE room SET gender_policy = 'female' WHERE site_id = $1`, [sc.dst.siteId])
    await approveTransfer(sc.src.aa.rc, { id, destinationBedId: null, ...none })
    const r = await approveTransfer(sc.dst.aa.rc, { id, destinationBedId: sc.dst.bedIds[1], ...none })
    expect(!r.ok && r.detail).toMatchObject({ reason: 'not_eligible' })
    expect((await transferRow(id)).destination_approved_at).toBeNull()
  })

  it('a person who became ineligible after both approvals is refused at execution (revalidated at the destination); nothing moves', async () => {
    const sc = await cross()
    await admin().query(`UPDATE staff_profile SET gender = 'male' WHERE id = $1`, [sc.res.staffId])
    const id = await requested(sc)
    await approvedByBoth(sc, id)
    await admin().query(`UPDATE room SET gender_policy = 'female' WHERE site_id = $1`, [sc.dst.siteId])
    const before = await snapshot(sc, sc.dst.bedIds[1])
    const out = await executeTransfer(sc.src.rec.rc, { id })
    expect(out.ok).toBe(false)
    expect(!out.ok && out.detail).toMatchObject({ reason: 'not_eligible', executionFailed: true })
    expect(!out.ok && out.owner).toBe('Policy Approver')
    expect(await snapshot(sc, sc.dst.bedIds[1])).toEqual(before)
    expect((await transferRow(id)).status).toBe('failed')
  })
})

describe('concurrency across sites', () => {
  it('two transfers from two different sites into the same destination bed at once: exactly one wins, the other fails safely and stays put', async () => {
    const a = await cross()
    const dest = a.dst.bedIds[1]
    // a second resident living in the third site wants the same bed
    const [other] = await residents(1)
    const otherStay = await mkStay({ bedId: a.third.bedIds[0], staffId: other.staffId, from: day(-5), to: day(30) })
    const ids: string[] = []
    const first = await requestTransfer(a.res.rc, xreq(a.stayId, dest))
    const second = await requestTransfer(other.rc, xreq(otherStay.stayId, dest))
    if (!first.ok || !second.ok) throw new Error('setup')
    ids.push(first.data.id, second.data.id)
    await approveTransfer(a.src.aa.rc, { id: ids[0], destinationBedId: null, ...none })
    await approveTransfer(a.third.aa.rc, { id: ids[1], destinationBedId: null, ...none })
    for (const id of ids) expect((await approveTransfer(a.dst.aa.rc, { id, destinationBedId: null, ...none })).ok).toBe(true)

    const results = await Promise.all([executeTransfer(a.src.rec.rc, { id: ids[0] }), executeTransfer(a.third.rec.rc, { id: ids[1] })])
    expect(results.filter(r => r.ok)).toHaveLength(1)
    const lost = results.find(r => !r.ok)!
    expect(!lost.ok && lost.detail).toMatchObject({ reason: 'bed_taken', executionFailed: true })
    expect(!lost.ok && lost.next).toBeTruthy()
    expect(await liveClaims(dest)).toHaveLength(1)
    const winner = results[0].ok ? 0 : 1
    const loserStay = winner === 0 ? otherStay : a
    const loserBed = winner === 0 ? a.third.bedIds[0] : a.src.bedIds[0]
    expect((await stayRow(loserStay.stayId)).bed_id).toBe(loserBed)
    expect(await bedState(loserBed)).toBe('occupied')
    expect((await transferRow(ids[winner])).status).toBe('executed')
    expect((await transferRow(ids[1 - winner])).status).toBe('failed')
  })

  it('executing the same cross-site transfer twice at once moves the resident once', async () => {
    const sc = await cross()
    const id = await requested(sc)
    await approvedByBoth(sc, id)
    const results = await Promise.all([executeTransfer(sc.src.rec.rc, { id }), executeTransfer(sc.dst.rec.rc, { id })])
    expect(results.filter(r => r.ok)).toHaveLength(1)
    expect((await stayRow(sc.stayId)).bed_id).toBe(sc.dst.bedIds[1])
    expect((await auditRows(id)).filter(a => a.action === 'stays.transfer.executed')).toHaveLength(1)
    expect((await admin().query(`SELECT 1 FROM cleaning_task WHERE bed_id = $1`, [sc.src.bedIds[0]])).rowCount).toBe(1)
  })

  it('approving both keys at once from two admins: each key is given once and the request ends up approved exactly once', async () => {
    const sc = await cross()
    const id = await requested(sc)
    const [a, b] = await Promise.all([
      approveTransfer(sc.src.aa.rc, { id, destinationBedId: null, ...none }),
      approveTransfer(sc.dst.aa.rc, { id, destinationBedId: null, ...none }),
    ])
    expect(a.ok && b.ok).toBe(true)
    const t = await transferRow(id)
    expect(t).toMatchObject({ status: 'approved', source_approved_by: sc.src.aa.userId, destination_approved_by: sc.dst.aa.userId })
    expect((await auditRows(id)).filter(x => x.action === 'stays.transfer.approved')).toHaveLength(1)
  })
})

describe('cross-site swap: one side failing leaves both residents in place', () => {
  it('the second resident cannot take the first one\'s bed at the other site any more: both stay put, both original claims are live, both keys are asked again', async () => {
    const sc = await twoStays()
    await admin().query(`UPDATE staff_profile SET gender = 'female' WHERE id = $1`, [sc.ra.staffId])
    await admin().query(`UPDATE staff_profile SET gender = 'male' WHERE id = $1`, [sc.rb.staffId])
    const id = await swapRequested(sc)
    expect((await approveTransfer(sc.srcAa2.rc, { id, destinationBedId: null, ...none })).ok).toBe(true)
    expect((await approveTransfer(sc.dst.aa.rc, { id, destinationBedId: null, ...none })).ok).toBe(true)
    // The source site's room turns female-only: the female resident may go to the destination (checked first), the male one may not come back.
    await admin().query(`UPDATE room SET gender_policy = 'female' WHERE site_id = $1`, [sc.src.siteId])

    const out = await executeTransfer(sc.src.rec.rc, { id })
    expect(out.ok).toBe(false)
    expect(!out.ok && out.detail).toMatchObject({ reason: 'not_eligible', executionFailed: true })
    const [a, b] = [await stayRow(sc.a.stayId), await stayRow(sc.b.stayId)]
    expect([a.bed_id, b.bed_id]).toEqual([sc.src.bedIds[0], sc.dst.bedIds[0]])
    expect([a.claim_id, b.claim_id]).toEqual([sc.a.claimId, sc.b.claimId])
    expect((await claimRow(sc.a.claimId)).released_at).toBeNull()
    expect((await claimRow(sc.b.claimId)).released_at).toBeNull()
    expect((await liveClaims(sc.src.bedIds[0])).map(c => c.id)).toEqual([sc.a.claimId])
    expect((await liveClaims(sc.dst.bedIds[0])).map(c => c.id)).toEqual([sc.b.claimId])
    expect(await bedState(sc.src.bedIds[0])).toBe('occupied')
    expect(await bedState(sc.dst.bedIds[0])).toBe('occupied')
    expect(await transferRow(id)).toMatchObject({ status: 'failed', source_approved_at: null, destination_approved_at: null }) // a swap asks both sites again
    const sites = (await admin().query<{ site_id: string }>(`SELECT site_id FROM audit_event WHERE entity_id = $1 AND action = 'stays.swap.failed'`, [id])).rows
    expect(sites.map(r => r.site_id).sort()).toEqual([sc.src.siteId, sc.dst.siteId].sort())
  })

  it('the destination bed of one side is booked beyond the other\'s stay: the whole swap fails, nobody moves', async () => {
    const sc = await twoStays()
    const id = await swapRequested(sc)
    await approveTransfer(sc.srcAa2.rc, { id, destinationBedId: null, ...none })
    await approveTransfer(sc.dst.aa.rc, { id, destinationBedId: null, ...none })
    // the source bed is booked from day 35, but resident B stays until day 40
    await mkReservation({ bedId: sc.src.bedIds[0], staffId: (await residents(1))[0].staffId, from: day(35), to: day(50) })
    const out = await executeTransfer(sc.dst.rec.rc, { id })
    expect(!out.ok && out.detail).toMatchObject({ reason: 'bed_taken', executionFailed: true })
    expect([(await stayRow(sc.a.stayId)).bed_id, (await stayRow(sc.b.stayId)).bed_id]).toEqual([sc.src.bedIds[0], sc.dst.bedIds[0]])
    expect((await claimRow(sc.a.claimId)).released_at).toBeNull()
    expect((await claimRow(sc.b.claimId)).released_at).toBeNull()
  })
})

describe('same-site flows behave exactly as before', () => {
  it('one decision gives both keys; no per-site audit rows; approval, execution and failure look like they always did', async () => {
    const w = await world({ beds: 4 })
    const aa2 = await person('AA', { siteIds: [w.siteId] })
    const [res] = await residents(1)
    const s = await mkStay({ bedId: w.bedIds[0], staffId: res.staffId, from: day(-5), to: day(30) })
    const r = await requestTransfer(res.rc, { stayId: s.stayId, destinationBedId: w.bedIds[1], reason: 'Quieter', neededBy: null, linkedExtensionId: null })
    if (!r.ok) throw new Error('setup')
    const id = r.data.id
    expect(r.data.crossSite).toBe(false)
    expect(await transferRow(id)).toMatchObject({ site_id: w.siteId, destination_site_id: w.siteId })
    const a = await approveTransfer(aa2.rc, { id, destinationBedId: null, note: null })
    expect(a.ok && a.data).toMatchObject({ status: 'approved', keys: { source: true, destination: true }, waitingFor: null })
    expect(await transferRow(id)).toMatchObject({ status: 'approved', source_approved_by: aa2.userId, destination_approved_by: aa2.userId, decided_by: aa2.userId })
    await setBedState(w.bedIds[1], 'blocked')
    expect((await executeTransfer(w.rec.rc, { id })).ok).toBe(false)
    // a failure clears both keys; one decision gives them back
    expect(await transferRow(id)).toMatchObject({ status: 'failed', source_approved_at: null, destination_approved_at: null })
    const re = await approveTransfer(aa2.rc, { id, destinationBedId: w.bedIds[2], note: null })
    expect(re.ok && re.data.status).toBe('approved')
    expect((await executeTransfer(w.rec.rc, { id })).ok).toBe(true)
    const actions = (await auditRows(id)).map(x => x.action)
    expect(actions).toEqual(['stays.transfer.requested', 'stays.transfer.approved', 'stays.transfer.failed', 'stays.transfer.approved', 'stays.transfer.executed'])
    expect(actions.some(x => /approved_(source|destination)|received|requested_cross_site/.test(x))).toBe(false)
  })

  it('a same-site swap is still one decision and still refuses cross-site-only paths', async () => {
    const w = await world({ beds: 2 })
    const aa2 = await person('AA', { siteIds: [w.siteId] })
    const [ra, rb] = await residents(2)
    const a = await mkStay({ bedId: w.bedIds[0], staffId: ra.staffId, from: day(-5), to: day(30) })
    const b = await mkStay({ bedId: w.bedIds[1], staffId: rb.staffId, from: day(-5), to: day(30) })
    const c = { via: 'in_person' as const, note: null }
    const r = await requestSwap(w.aa.rc, { stayId: a.stayId, otherStayId: b.stayId, reason: 'x', neededBy: null, consentFirst: c, consentSecond: c })
    if (!r.ok) throw new Error('setup')
    expect(r.data.crossSite).toBe(false)
    expect((await approveTransfer(aa2.rc, { id: r.data.id, destinationBedId: null, note: null })).ok).toBe(true)
    expect((await executeTransfer(w.rec.rc, { id: r.data.id })).ok).toBe(true)
  })
})
