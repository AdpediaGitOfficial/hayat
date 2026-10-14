/**
 * Hardening round, WP-N, S-21 (AT-036): the OTHER state of each proposal, in a PRIVATE database because it changes global settings
 * (the shared test database is used by every test file at once):
 *   P-09 Reception may raise transfers: ON    (shipped OFF)
 *   P-10 Policy Approver exception:     OFF   (shipped ON)
 *   P-11 swap partner by employee ID:   ON    (shipped OFF)
 *   P-12 future bookings:               review (shipped cancel)
 * Every one of these is "proposed, pending client sign-off"; nothing here treats one as approved.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createIsolated, PASSWORD } from '../access/isolated'
import { FixedClock } from '@/server/clock'
import { DAY_MS, NOW, day, kit } from './iso'
import { getDb } from '@/server/db/client'
import { listInbox } from '@/server/approvals/inbox'
import { runSweep } from '@/server/jobs/registry'
import '@/server/jobs/sweeps'
import { approveTransfer } from '@/server/commands/stays/decideTransfer'
import { executeTransfer } from '@/server/commands/stays/executeTransfer'
import { requestSwap, requestTransfer } from '@/server/commands/stays/requestTransfer'
import { declineTransferException, grantTransferException } from '@/server/commands/stays/transferException'
import { LOOKUP_LIMIT, lookupSwapPartner } from '@/server/commands/stays/swapPartner'
import { listTransfers } from '@/server/queries/stays/transfers'
import { decide } from '@/server/policy'
import { stayAbilities } from '@/server/queries/stays/stays'

const iso = await createIsolated()
afterAll(() => iso.close())
const clock = new FixedClock(NOW)
const k = kit(iso, clock)
const none = { note: null }
const consent = { via: 'in_person' as const, note: null }

/** A new configuration version (the table is append-only). */
const setting = (key: string, value: unknown) => k.q(
  `INSERT INTO config_item (key, scope_site_id, version, value) VALUES ($1, NULL, COALESCE((SELECT max(version) FROM config_item WHERE key = $1 AND scope_site_id IS NULL), 0) + 1, $2::jsonb)`, [key, JSON.stringify(value)])
beforeEach(() => { clock.set(NOW) })

async function named(label: string, beds = 3) {
  const w = await k.world(beds)
  const name = `${label} ${k.uniq('s')}`
  await k.q(`UPDATE site SET name = $2 WHERE id = $1`, [w.siteId, name])
  return { ...w, name }
}
/** Two sites and a resident with an active stay in the first. */
async function scene() {
  const src = await named('Source'), dst = await named('Destination'), third = await named('Third', 1)
  const srcAa2 = await k.person('AA', { siteIds: [src.siteId] })
  const res = await src.res()
  const s = await k.stay({ bedId: src.bedIds[0], staffId: res.staffId, from: day(-5), to: day(30) })
  return { src, dst, third, srcAa2, res, ...s }
}
const xreq = (stayId: string, destinationBedId: string | null, destinationSiteId: string | null = null) => ({ stayId, destinationBedId, destinationSiteId, reason: 'New project', neededBy: null, linkedExtensionId: null })
const male = (staffId: string) => k.q(`UPDATE staff_profile SET gender = 'male' WHERE id = $1`, [staffId])
const femaleOnly = (siteId: string) => k.q(`UPDATE room SET gender_policy = 'female' WHERE site_id = $1`, [siteId])
const policyApprover = (siteId: string) => k.person('Mgr', { siteIds: [siteId], caps: ['PolicyApprover'] })

/* ====================================================================== P-09 ON ====================================================================== */

describe('AT-036 P-09 (proposed, pending client sign-off) with transfers.reception_may_raise ON: Reception raises on behalf of a resident at their site, and never approves', () => {
  it('a transfer is raised, recorded as raised by Reception, and the Accommodation Admin and the resident are told', async () => {
    await setting('transfers.reception_may_raise', true)
    const sc = await scene()
    const r = await requestTransfer(sc.src.rec.rc, xreq(sc.stayId, sc.src.bedIds[1]))
    expect(r.ok, JSON.stringify(r)).toBe(true)
    if (!r.ok) return
    const row = (await k.q(`SELECT requested_by, requested_by_staff_id, status, staff_id FROM transfer_request WHERE id = $1`, [r.data.id]))[0]
    expect(row).toMatchObject({ requested_by: sc.src.rec.userId, requested_by_staff_id: sc.src.rec.staffId, status: 'requested', staff_id: sc.res.staffId })
    const req = (await k.audits(r.data.id)).find(a => a.action === 'stays.transfer.requested')!
    expect(req).toMatchObject({ actor_role: 'Rec', actor_user_id: sc.src.rec.userId })
    expect(req.after).toMatchObject({ onBehalf: true, raisedByRole: 'Rec' })
    const told = await k.notifications(r.data.id)
    expect(told.some(n => n.to_role === 'AA')).toBe(true)
    expect(told.some(n => n.to_staff_id === sc.res.staffId)).toBe(true)
    expect(r.message).toMatch(/Reception never approves/)
    // the screen's view says who raised it
    const card = (await listTransfers(sc.src.aa.rc.actor, { status: 'open' }, new Date(NOW))).find(t => t.id === r.data.id)!
    expect(card.raisedBy).not.toBeNull()
  })

  it('Reception of ANOTHER site is "not found"; the resident\'s own and the admin\'s requests are unchanged; the abilities follow the setting', async () => {
    await setting('transfers.reception_may_raise', true)
    const sc = await scene()
    const other = await k.person('Rec', { siteIds: [sc.third.siteId] })
    const r = await requestTransfer(other.rc, xreq(sc.stayId, sc.src.bedIds[1]))
    expect(!r.ok && r.code).toBe('not_found')
    expect((await requestTransfer(sc.res.rc, xreq(sc.stayId, sc.src.bedIds[1]))).ok).toBe(true)
    const abilityOn = stayAbilities(sc.src.rec.rc.actor, { siteId: sc.src.siteId, staffId: sc.res.staffId }, { receptionMayRaise: true })
    const abilityOff = stayAbilities(sc.src.rec.rc.actor, { siteId: sc.src.siteId, staffId: sc.res.staffId }, { receptionMayRaise: false })
    expect([abilityOn.requestTransfer, abilityOff.requestTransfer]).toEqual([true, false])
  })

  it('a swap is raised by Reception on either of its two sites; still needs both consents and independent approvals', async () => {
    await setting('transfers.reception_may_raise', true)
    const src = await named('Source'), dst = await named('Destination')
    const ra = await src.res(), rb = await dst.res()
    const a = await k.stay({ bedId: src.bedIds[0], staffId: ra.staffId, from: day(-5), to: day(30) })
    const b = await k.stay({ bedId: dst.bedIds[0], staffId: rb.staffId, from: day(-2), to: day(40) })
    // a Reception person with scope on the SECOND site only may raise it (one of the two is enough, like an Accommodation Admin)
    const r = await requestSwap(dst.rec.rc, { stayId: a.stayId, otherStayId: b.stayId, reason: 'Friends swap', neededBy: null, consentFirst: consent, consentSecond: consent })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    if (!r.ok) return
    expect((await k.audits(r.data.id)).find(x => x.action === 'stays.swap.requested')!.after).toMatchObject({ raisedByRole: 'Rec' })
    const stranger = await named('Stranger')
    const none3 = await requestSwap((await k.person('Rec', { siteIds: [stranger.siteId] })).rc, { stayId: a.stayId, otherStayId: b.stayId, reason: 'x', neededBy: null, consentFirst: null, consentSecond: null })
    expect(!none3.ok && none3.code).toBe('not_found')
    // and the Reception person who raised it cannot approve it
    const approve = await approveTransfer(dst.rec.rc, { id: r.data.id, destinationBedId: null, ...none })
    expect(!approve.ok && approve.code).toBe('forbidden')
  })

  it('Reception never approves, whatever the setting says, and a Reception person holding the Policy Approver and Backup Approver capabilities cannot approve what they raised even once it is escalated (D-109)', async () => {
    await setting('transfers.reception_may_raise', true)
    const sc = await scene()
    for (const action of ['transfers_swaps.approve'] as const) expect(decide(sc.src.rec.rc.actor, action, { siteId: sc.src.siteId }).allowed).toBe(false)
    const powerful = await k.person('Rec', { siteIds: [sc.src.siteId, sc.dst.siteId], caps: ['PolicyApprover', 'BackupApprover'] })
    const r = await requestTransfer(powerful.rc, xreq(sc.stayId, null, sc.dst.siteId))
    expect(r.ok, JSON.stringify(r)).toBe(true)
    if (!r.ok) return
    clock.set(NOW + 6 * DAY_MS) // well past the backup level of the approval clock
    const a = await approveTransfer(powerful.rc, { id: r.data.id, destinationBedId: null, ...none })
    expect(!a.ok && a.code).toBe('separation_of_duties')
    const rej = await (await import('@/server/commands/stays/decideTransfer')).rejectTransfer(powerful.rc, { id: r.data.id, reason: 'I changed my mind' })
    expect(!rej.ok && rej.code).toBe('separation_of_duties')
    expect((await k.q(`SELECT source_approved_at, status FROM transfer_request WHERE id = $1`, [r.data.id]))[0]).toMatchObject({ source_approved_at: null, status: 'requested' })
  })
})

/* ====================================================================== P-10 OFF ====================================================================== */

describe('AT-036 P-10 (proposed, pending client sign-off) with transfers.exception_path OFF: a destination that fails a rule is simply refused, as before', () => {
  it('the refusal no longer points at a Policy Approver, asking for an exception is "policy not in force", nothing is stored, no approval item exists', async () => {
    await setting('transfers.exception_path', false)
    const sc = await scene()
    await male(sc.res.staffId); await femaleOnly(sc.dst.siteId)

    const refused = await requestTransfer(sc.res.rc, xreq(sc.stayId, sc.dst.bedIds[1]))
    expect(!refused.ok && refused.detail).toMatchObject({ reason: 'not_eligible', exceptionable: true, canAskException: false })
    expect(!refused.ok && refused.next).toMatch(/not in force: proposed, pending client sign-off/)

    const asked = await requestTransfer(sc.res.rc, { ...xreq(sc.stayId, sc.dst.bedIds[1]), askException: true })
    expect(!asked.ok && asked.reason).toMatch(/policy not in force: proposed, pending client sign-off/)
    expect(!asked.ok && asked.detail).toMatchObject({ reason: 'policy_not_in_force', policy: 'P-10' })
    expect((await k.q(`SELECT 1 FROM transfer_request WHERE stay_id = $1`, [sc.stayId]))).toHaveLength(0)

    // a request that exists anyway (any suitable bed): the destination admin's approval of that bed is refused, asking is refused too
    const r = await requestTransfer(sc.res.rc, xreq(sc.stayId, null, sc.dst.siteId))
    if (!r.ok) throw new Error(r.reason)
    await approveTransfer(sc.src.aa.rc, { id: r.data.id, destinationBedId: null, ...none })
    const dstAa = sc.dst.aa
    const plain = await approveTransfer(dstAa.rc, { id: r.data.id, destinationBedId: sc.dst.bedIds[1], ...none })
    expect(!plain.ok && plain.detail).toMatchObject({ reason: 'not_eligible', canAskException: false })
    const ask = await approveTransfer(dstAa.rc, { id: r.data.id, destinationBedId: sc.dst.bedIds[1], askException: true, ...none })
    expect(!ask.ok && ask.detail).toMatchObject({ reason: 'policy_not_in_force', policy: 'P-10' })
    expect((await k.q(`SELECT to_bed_id, destination_approved_at FROM transfer_request WHERE id = $1`, [r.data.id]))[0]).toMatchObject({ to_bed_id: null, destination_approved_at: null })
  })

  it('granting and declining are refused (policy not in force, owner Super Admin); no exception row; no card; no inbox item; a swap is not held back', async () => {
    await setting('transfers.exception_path', false)
    const w = await named('One', 4)
    const aa2 = await k.person('AA', { siteIds: [w.siteId] })
    const pa = await policyApprover(w.siteId)
    const res = await w.res()
    await male(res.staffId)
    const s = await k.stay({ bedId: w.bedIds[0], staffId: res.staffId, from: day(-3), to: day(40) })
    const r = await requestTransfer(res.rc, { stayId: s.stayId, destinationBedId: w.bedIds[1], reason: 'x', neededBy: null, linkedExtensionId: null })
    if (!r.ok) throw new Error(r.reason)
    await approveTransfer(w.aa.rc, { id: r.data.id, destinationBedId: null, ...none })
    await k.q(`UPDATE room SET gender_policy = 'female' WHERE id = $1`, [w.roomId])
    const out = await executeTransfer(w.rec.rc, { id: r.data.id })
    expect(!out.ok && out.detail).toMatchObject({ reason: 'not_eligible', executionFailed: true })

    const g = await grantTransferException(pa.rc, { transferId: r.data.id, staffId: null, kinds: ['gender'], reason: 'Needed', evidence: 'Memo', confirmPassword: PASSWORD })
    expect(!g.ok && g.reason).toMatch(/policy not in force: proposed, pending client sign-off/)
    expect(!g.ok && g.owner).toBe('Super Admin')
    const d = await declineTransferException(pa.rc, { transferId: r.data.id, staffId: null, reason: 'No', confirmPassword: PASSWORD })
    expect(!d.ok && d.detail).toMatchObject({ reason: 'policy_not_in_force' })
    expect(await k.q(`SELECT 1 FROM eligibility_exception WHERE transfer_request_id = $1`, [r.data.id])).toHaveLength(0)
    expect(await k.q(`SELECT 1 FROM transfer_exception_decision WHERE transfer_request_id = $1`, [r.data.id])).toHaveLength(0)
    const card = (await listTransfers(pa.rc.actor, { status: 'open' }, new Date(NOW))).find(t => t.id === r.data.id)!
    expect(card).toMatchObject({ exceptions: [], exceptionPath: false })
    expect((await listInbox(getDb(), pa.rc.actor, new Date(NOW))).filter(i => i.kind.startsWith('transfer_exception'))).toEqual([])
    // the failed transfer can be approved again: nobody holds it back
    expect((await approveTransfer(aa2.rc, { id: r.data.id, destinationBedId: null, ...none })).ok).toBe(true)
  })

  it('a swap that fails a rule is approved as before and fails at execution, with everyone where they were (OFF = the previous behaviour)', async () => {
    await setting('transfers.exception_path', false)
    const w = await named('Swap', 4)
    const aa2 = await k.person('AA', { siteIds: [w.siteId] })
    const ra = await w.res(), rb = await w.res()
    await male(ra.staffId)
    await k.q(`UPDATE staff_profile SET gender = 'female' WHERE id = $1`, [rb.staffId])
    const a = await k.stay({ bedId: w.bedIds[0], staffId: ra.staffId, from: day(-5), to: day(30) })
    const b = await k.stay({ bedId: w.bedIds[1], staffId: rb.staffId, from: day(-5), to: day(40) })
    await k.q(`UPDATE room SET gender_policy = 'female' WHERE id = $1`, [w.roomId])
    const r = await requestSwap(w.aa.rc, { stayId: a.stayId, otherStayId: b.stayId, reason: 'x', neededBy: null, consentFirst: consent, consentSecond: consent })
    if (!r.ok) throw new Error(r.reason)
    expect((await approveTransfer(aa2.rc, { id: r.data.id, destinationBedId: null, ...none })).ok).toBe(true)
    const out = await executeTransfer(w.rec.rc, { id: r.data.id })
    expect(!out.ok && out.detail).toMatchObject({ reason: 'not_eligible', executionFailed: true })
    expect((await k.stayRow(a.stayId)).bed_id).toBe(w.bedIds[0])
    expect((await k.stayRow(b.stayId)).bed_id).toBe(w.bedIds[1])
  })
})

describe('AT-036 P-10 (ON again): the reminders remind the Policy Approver and decide nothing', () => {
  it('a move waiting for an exception is reminded, backed up and escalated by the approvals sweep; the request, the stay and the beds are never touched', async () => {
    await setting('transfers.exception_path', true)
    const sc = await scene()
    await male(sc.res.staffId); await femaleOnly(sc.dst.siteId)
    const r = await requestTransfer(sc.res.rc, xreq(sc.stayId, null, sc.dst.siteId))
    if (!r.ok) throw new Error(r.reason)
    await approveTransfer(sc.src.aa.rc, { id: r.data.id, destinationBedId: null, ...none })
    const asked = await approveTransfer(sc.dst.aa.rc, { id: r.data.id, destinationBedId: sc.dst.bedIds[1], askException: true, ...none })
    expect(asked.ok && asked.data.waitingForException).toBe(true)

    for (const days of [1, 2, 3, 5, 10, 30]) { clock.set(NOW + days * DAY_MS); await runSweep('approval_reminders', clock) }
    clock.set(NOW)
    const rows = await k.q<{ kind: string; to_role: string; site_id: string }>(
      `SELECT kind, to_role, site_id FROM notification WHERE dedupe_key LIKE $1`, [`approval:transfer_exception:${r.data.id}:%`])
    expect(rows.map(x => x.kind).sort()).toEqual(['approval.backup', 'approval.escalated', 'approval.reminder'])
    expect(rows.find(x => x.kind === 'approval.reminder')).toMatchObject({ to_role: 'PolicyApprover', site_id: sc.dst.siteId })
    const t = (await k.q(`SELECT status, destination_approved_at, executed_at, to_bed_id FROM transfer_request WHERE id = $1`, [r.data.id]))[0]
    expect(t).toMatchObject({ status: 'requested', destination_approved_at: null, executed_at: null, to_bed_id: sc.dst.bedIds[1] })
    expect((await k.q(`SELECT 1 FROM eligibility_exception WHERE transfer_request_id = $1`, [r.data.id]))).toHaveLength(0) // a timer never grants
    expect((await k.stayRow(sc.stayId)).bed_id).toBe(sc.src.bedIds[0])
    expect(await k.bedState(sc.dst.bedIds[1])).toBe('available')
  })
})

/* ====================================================================== P-11 ON ====================================================================== */

describe('AT-036 P-11 (proposed, pending client sign-off) with transfers.swap_partner_lookup ON: a swap partner by employee ID, name and site of an active stay only', () => {
  async function pair() {
    const src = await named('Source'), dst = await named('Destination')
    const ra = await src.res(), rb = await dst.res()
    const a = await k.stay({ bedId: src.bedIds[0], staffId: ra.staffId, from: day(-5), to: day(30) })
    const b = await k.stay({ bedId: dst.bedIds[0], staffId: rb.staffId, from: day(-2), to: day(40) })
    const idOf = async (staffId: string) => (await k.q<{ employee_id: string }>(`SELECT employee_id FROM staff_profile WHERE id = $1`, [staffId]))[0].employee_id
    return { src, dst, ra, rb, a, b, idOf }
  }

  it('an admin finds the person at ANOTHER site: the name and the site name, nothing else', async () => {
    await setting('transfers.swap_partner_lookup', true)
    const p = await pair()
    const hit = await lookupSwapPartner(p.src.aa.rc, { employeeId: await p.idOf(p.rb.staffId) })
    expect(hit.ok, JSON.stringify(hit)).toBe(true)
    if (!hit.ok) return
    expect(Object.keys(hit.data).sort()).toEqual(['name', 'siteName'])
    expect(hit.data).toEqual({ name: (await k.q<{ full_name: string }>(`SELECT full_name FROM staff_profile WHERE id = $1`, [p.rb.staffId]))[0].full_name, siteName: p.dst.name })
    // case and spaces in the typed ID do not matter
    const sloppy = await lookupSwapPartner(p.src.aa.rc, { employeeId: `  ${(await p.idOf(p.rb.staffId)).toLowerCase()} ` })
    expect(sloppy.ok).toBe(true)
  })

  it('an unknown ID, a person who left, a person with no stay, a provisional stay and a checked-out stay all get the SAME answer: nothing about who exists', async () => {
    await setting('transfers.swap_partner_lookup', true)
    const p = await pair()
    const left = await p.src.res()
    await k.stay({ bedId: p.src.bedIds[1], staffId: left.staffId, from: day(-2), to: day(30) })
    await k.q(`UPDATE staff_profile SET employment_status = 'left' WHERE id = $1`, [left.staffId])
    const homeless = await p.src.res()
    const provisional = await p.src.res()
    const claim = (await k.q<{ id: string }>(`INSERT INTO bed_claim (bed_id, kind, period) VALUES ($1, 'stay', $2::daterange) RETURNING id`, [p.src.bedIds[2], `[${day(-1)},)`]))[0].id
    await k.q(`INSERT INTO stay (staff_id, bed_id, claim_id, status, source, stay_type, checked_in_at) VALUES ($1, $2, $3, 'provisional', 'provisional', 'contract', now())`, [provisional.staffId, p.src.bedIds[2], claim])
    const gone = await p.dst.res()
    const gs = await k.stay({ bedId: p.dst.bedIds[1], staffId: gone.staffId, from: day(-9), to: day(-1) })
    await k.q(`UPDATE stay SET status = 'checked_out', checked_out_at = now() WHERE id = $1`, [gs.stayId])

    const asks = [`NOPE-${k.uniq('x')}`, await p.idOf(left.staffId), await p.idOf(homeless.staffId), await p.idOf(provisional.staffId), await p.idOf(gone.staffId)]
    const answers = []
    for (const employeeId of asks) {
      const r = await lookupSwapPartner(p.src.aa.rc, { employeeId })
      expect(r.ok).toBe(false)
      answers.push(JSON.stringify(r))
    }
    expect(new Set(answers).size).toBe(1)
    const one = JSON.parse(answers[0])
    expect(one).toMatchObject({ code: 'not_found', detail: { reason: 'no_active_stay' } })
    for (const employeeId of asks) expect(answers[0]).not.toContain(employeeId)
  })

  it('every lookup counts, found or not; after the limit the answer is "too many attempts" until the window passes; each person has their own count', async () => {
    await setting('transfers.swap_partner_lookup', true)
    const p = await pair()
    const aa = await k.person('AA', { siteIds: [p.src.siteId] })
    const other = await k.person('AA', { siteIds: [p.src.siteId] })
    for (let n = 0; n < LOOKUP_LIMIT; n++) expect((await lookupSwapPartner(aa.rc, { employeeId: `NOPE-${n}` })).ok).toBe(false)
    const blocked = await lookupSwapPartner(aa.rc, { employeeId: await p.idOf(p.rb.staffId) })
    expect(!blocked.ok && blocked.code).toBe('rate_limited')
    expect(blocked.ok).toBe(false)
    expect((await lookupSwapPartner(other.rc, { employeeId: await p.idOf(p.rb.staffId) })).ok).toBe(true) // another person is not held back
    clock.set(NOW + 11 * 60_000)
    expect((await lookupSwapPartner(aa.rc, { employeeId: await p.idOf(p.rb.staffId) })).ok).toBe(true) // the window passed
  })

  it('who may look: the admin, never a resident, a Manager or an Auditor; Reception only when P-09 is also on', async () => {
    await setting('transfers.swap_partner_lookup', true)
    const p = await pair()
    const target = await p.idOf(p.rb.staffId)
    for (const role of ['Res', 'Mgr', 'Aud'] as const) {
      const who = await k.person(role, { siteIds: [p.src.siteId] })
      const r = await lookupSwapPartner(who.rc, { employeeId: target })
      expect(!r.ok && r.code, role).toBe('forbidden')
    }
    await setting('transfers.reception_may_raise', false)
    const off = await lookupSwapPartner(p.src.rec.rc, { employeeId: target })
    expect(!off.ok && off.reason).toMatch(/policy not in force/)
    expect(!off.ok && off.detail).toMatchObject({ policy: 'P-09' })
    await setting('transfers.reception_may_raise', true)
    expect((await lookupSwapPartner(p.src.rec.rc, { employeeId: target })).ok).toBe(true)
    await setting('transfers.reception_may_raise', false)
  })

  it('the swap by employee ID works end to end across sites: the stay is resolved on the server, both sites approve, the beds are exchanged', async () => {
    await setting('transfers.swap_partner_lookup', true)
    const p = await pair()
    const srcAa2 = await k.person('AA', { siteIds: [p.src.siteId] })
    const dstAa = await k.person('AA', { siteIds: [p.dst.siteId] })
    const r = await requestSwap(p.src.aa.rc, { stayId: p.a.stayId, otherEmployeeId: await p.idOf(p.rb.staffId), reason: 'Friends swap', neededBy: null, consentFirst: consent, consentSecond: consent })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    if (!r.ok) return
    expect(r.data.crossSite).toBe(true)
    expect((await k.q(`SELECT other_stay_id, other_staff_id FROM transfer_request WHERE id = $1`, [r.data.id]))[0]).toMatchObject({ other_stay_id: p.b.stayId, other_staff_id: p.rb.staffId })
    expect((await k.audits(r.data.id)).find(a => a.action === 'stays.swap.requested')!.after).toMatchObject({ partnerNamedByEmployeeId: true })
    expect((await approveTransfer(srcAa2.rc, { id: r.data.id, destinationBedId: null, ...none })).ok).toBe(true)
    expect((await approveTransfer(dstAa.rc, { id: r.data.id, destinationBedId: null, ...none })).ok).toBe(true)
    const rec = await k.person('Rec', { siteIds: [p.src.siteId, p.dst.siteId] })
    expect((await executeTransfer(rec.rc, { id: r.data.id })).ok).toBe(true)
    expect((await k.stayRow(p.a.stayId)).bed_id).toBe(p.dst.bedIds[0])
    expect((await k.stayRow(p.b.stayId)).bed_id).toBe(p.src.bedIds[0])
  })

  it('asking for someone who is not an active resident is the same answer as the lookup and stores nothing; both ways of naming at once is a mistake; a third site\'s admin gets "not found" for the stays', async () => {
    await setting('transfers.swap_partner_lookup', true)
    const p = await pair()
    const unknown = await requestSwap(p.src.aa.rc, { stayId: p.a.stayId, otherEmployeeId: 'NOPE-1', reason: 'x', neededBy: null, consentFirst: null, consentSecond: null })
    const looked = await lookupSwapPartner(p.src.aa.rc, { employeeId: 'NOPE-1' })
    expect(unknown).toEqual(looked)
    expect(await k.q(`SELECT 1 FROM transfer_request WHERE stay_id = $1`, [p.a.stayId])).toHaveLength(0)
    const both = await requestSwap(p.src.aa.rc, { stayId: p.a.stayId, otherStayId: p.b.stayId, otherEmployeeId: await p.idOf(p.rb.staffId), reason: 'x', neededBy: null, consentFirst: null, consentSecond: null })
    expect(!both.ok && both.code).toBe('invalid')
    const third = await named('Third', 1)
    const noScope = await requestSwap((await k.person('AA', { siteIds: [third.siteId] })).rc, { stayId: p.a.stayId, otherEmployeeId: await p.idOf(p.rb.staffId), reason: 'x', neededBy: null, consentFirst: null, consentSecond: null })
    expect(!noScope.ok && noScope.code).toBe('not_found') // the feature lets an admin NAME the partner; it never gives scope over the stays
  })
})

/* ====================================================================== P-12 review ====================================================================== */

describe('AT-036 P-12 (proposed, pending client sign-off) with transfers.future_bookings = review: stray bookings are left and the Accommodation Admin of the new site is told once, with the list', () => {
  async function stray(sc: Awaited<ReturnType<typeof scene>>) {
    const rv = await k.reservation({ bedId: sc.dst.bedIds[2], staffId: sc.res.staffId, from: day(40), to: day(60) })
    const entry = (await k.q<{ id: string }>(
      `INSERT INTO waitlist_entry (staff_id, site_id, expires_at, arrival_date, end_date, stay_type, status) VALUES ($1, $2, $3, $4, $5, 'contract', 'offered') RETURNING id`,
      [sc.res.staffId, sc.src.siteId, day(15), day(5), day(65)]))[0].id
    const hold = (await k.q<{ id: string }>(`INSERT INTO bed_claim (bed_id, kind, period) VALUES ($1, 'offer_hold', $2::daterange) RETURNING id`, [sc.src.bedIds[2], `[${day(5)},${day(65)})`]))[0].id
    const offer = (await k.q<{ id: string }>(`INSERT INTO bed_offer (staff_id, waitlist_entry_id, bed_id, claim_id, status) VALUES ($1, $2, $3, $4, 'pending') RETURNING id`, [sc.res.staffId, entry, sc.src.bedIds[2], hold]))[0].id
    return { rv, entry, hold, offer }
  }

  it('nothing is cancelled, closed or withdrawn; the new site\'s admin is told once with the list; the audit says what was left; the move itself is unaffected', async () => {
    await setting('transfers.future_bookings', 'review')
    const sc = await scene()
    const s = await stray(sc)
    const r = await requestTransfer(sc.res.rc, xreq(sc.stayId, sc.dst.bedIds[1]))
    if (!r.ok) throw new Error(r.reason)
    await approveTransfer(sc.src.aa.rc, { id: r.data.id, destinationBedId: null, ...none })
    await approveTransfer(sc.dst.aa.rc, { id: r.data.id, destinationBedId: null, ...none })
    const done = await executeTransfer(sc.dst.rec.rc, { id: r.data.id })
    expect(done.ok, JSON.stringify(done)).toBe(true)
    expect((await k.stayRow(sc.stayId)).bed_id).toBe(sc.dst.bedIds[1])

    // still there, untouched
    expect((await k.reservationRow(s.rv.reservationId)).status).toBe('reserved')
    expect((await k.claimRow(s.rv.claimId)).released_at).toBeNull()
    expect((await k.q(`SELECT status FROM waitlist_entry WHERE id = $1`, [s.entry]))[0].status).toBe('offered')
    expect((await k.q(`SELECT status FROM bed_offer WHERE id = $1`, [s.offer]))[0].status).toBe('pending')
    expect((await k.claimRow(s.hold)).released_at).toBeNull()
    expect((await k.liveClaims(sc.dst.bedIds[2])).length).toBe(1)

    // one notification to the Accommodation Admin of the NEW site, event-based key, with the list
    const told = await k.q<{ dedupe_key: string; to_role: string; site_id: string; text: string }>(`SELECT dedupe_key, to_role, site_id, text FROM notification WHERE dedupe_key LIKE $1`, [`transfer:${r.data.id}:future_bookings:%`])
    expect(told).toHaveLength(1)
    expect(told[0]).toMatchObject({ dedupe_key: `transfer:${r.data.id}:future_bookings:${sc.res.staffId}`, to_role: 'AA', site_id: sc.dst.siteId })
    expect(told[0].text).toMatch(/reservation for .*Bed/)
    expect(told[0].text).toMatch(/bed offer pending/)
    expect(told[0].text).toMatch(/waitlist entry at/)
    expect(told[0].text).toMatch(/Nothing was cancelled/)
    // audit: on the stay (site of the new bed) and in the move's own record
    const left = (await k.audits(sc.stayId)).find(a => a.action === 'stays.transfer.bookings_left_for_review')!
    expect(left.after).toMatchObject({ transferId: r.data.id, reservationIds: [s.rv.reservationId], waitlistEntryIds: [s.entry], offerIds: [s.offer] })
    const ex = (await k.audits(r.data.id)).find(a => a.action === 'stays.transfer.executed')!
    expect(ex.after.followUps.future_bookings).toMatchObject({ mode: 'review', reservationsLeft: 1, waitlistEntriesLeft: 1, offersLeft: 1 })
    expect((await k.audits(s.rv.reservationId)).map(a => a.action)).not.toContain('stays.transfer.booking_cancelled')
  })

  it('no stray bookings: no notification, a zero outcome; a swap tells the new site\'s admin once PER person', async () => {
    await setting('transfers.future_bookings', 'review')
    const sc = await scene()
    const r = await requestTransfer(sc.res.rc, xreq(sc.stayId, sc.dst.bedIds[1]))
    if (!r.ok) throw new Error(r.reason)
    await approveTransfer(sc.src.aa.rc, { id: r.data.id, destinationBedId: null, ...none })
    await approveTransfer(sc.dst.aa.rc, { id: r.data.id, destinationBedId: null, ...none })
    expect((await executeTransfer(sc.dst.rec.rc, { id: r.data.id })).ok).toBe(true)
    expect(await k.q(`SELECT 1 FROM notification WHERE dedupe_key LIKE $1`, [`transfer:${r.data.id}:future_bookings:%`])).toHaveLength(0)
    expect((await k.audits(r.data.id)).find(a => a.action === 'stays.transfer.executed')!.after.followUps.future_bookings).toMatchObject({ mode: 'review', reservationsLeft: 0 })

    const src = await named('SwapSrc'), dst = await named('SwapDst')
    const ra = await src.res(), rb = await dst.res()
    const a = await k.stay({ bedId: src.bedIds[0], staffId: ra.staffId, from: day(-5), to: day(30) })
    const b = await k.stay({ bedId: dst.bedIds[0], staffId: rb.staffId, from: day(-2), to: day(40) })
    await k.reservation({ bedId: dst.bedIds[1], staffId: ra.staffId, from: day(50), to: day(60) })
    await k.reservation({ bedId: src.bedIds[1], staffId: rb.staffId, from: day(50), to: day(60) })
    const sw = await requestSwap(src.aa.rc, { stayId: a.stayId, otherStayId: b.stayId, reason: 'x', neededBy: null, consentFirst: consent, consentSecond: consent })
    if (!sw.ok) throw new Error(sw.reason)
    const srcAa2 = await k.person('AA', { siteIds: [src.siteId] }), dstAa = await k.person('AA', { siteIds: [dst.siteId] })
    await approveTransfer(srcAa2.rc, { id: sw.data.id, destinationBedId: null, ...none })
    await approveTransfer(dstAa.rc, { id: sw.data.id, destinationBedId: null, ...none })
    const rec = await k.person('Rec', { siteIds: [src.siteId, dst.siteId] })
    expect((await executeTransfer(rec.rc, { id: sw.data.id })).ok).toBe(true)
    const told = await k.q<{ site_id: string; dedupe_key: string }>(`SELECT site_id, dedupe_key FROM notification WHERE dedupe_key LIKE $1 ORDER BY dedupe_key`, [`transfer:${sw.data.id}:future_bookings:%`])
    expect(told.map(t => t.site_id).sort()).toEqual([src.siteId, dst.siteId].sort()) // each person's NEW site
    expect(await k.q(`SELECT 1 FROM reservation WHERE staff_id = ANY($1::uuid[]) AND status = 'reserved'`, [[ra.staffId, rb.staffId]])).toHaveLength(2)
  })
})
