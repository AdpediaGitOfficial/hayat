/**
 * Hardening round, WP-N, S-21 (AT-036), the SHIPPED state of each proposal (the other state is in hardening-n-flags.test.ts, which has a
 * database of its own because it changes global settings):
 *   P-09 Reception may raise transfers: OFF   -> refused with "policy not in force", never approves in any case
 *   P-10 Policy Approver exception:     ON    -> the whole path, its guards, its scope to ONE transfer, its audit
 *   P-11 swap partner by employee ID:   OFF   -> refused, nothing revealed
 *   P-12 future bookings:               cancel -> nothing dangling
 *   and the destination checks of transfers and swaps (single-site, cross-site, both swap directions), table driven.
 * Every proposal is "proposed, pending client sign-off"; nothing here treats one as approved.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { admin, closeAll, PASSWORD } from '../harness'
import { mkItem } from '../fixtures3'
import {
  as, auditRows, bedState, claimRow, day, liveClaims, mkReservation, mkRoom, mkBed, mkStay, notificationsFor, person, residents, setBedState, setConfigValue, stayRow, transferRow, world,
} from './helpers'
import { approveTransfer } from '@/server/commands/stays/decideTransfer'
import { executeTransfer } from '@/server/commands/stays/executeTransfer'
import { requestSwap, requestTransfer } from '@/server/commands/stays/requestTransfer'
import { declineInput, declineTransferException, exceptionNeeds, grantInput, grantTransferException } from '@/server/commands/stays/transferException'
import { loadTransfer } from '@/server/commands/stays/transferShared'
import { lookupSwapPartner } from '@/server/commands/stays/swapPartner'
import { approvedByBoth, cross, requested, twoStays, xreq, type Cross } from './crossHelpers'
import { checkEligibility } from '@/server/eligibility'
import { listInbox } from '@/server/approvals/inbox'
import { listTransfers } from '@/server/queries/stays/transfers'
import { getDb } from '@/server/db/client'
import { decide } from '@/server/policy'
import { cancelRequest } from '@/server/commands/stays/cancel'

afterAll(closeAll)
const none = { note: null }
const NOW_DATE = () => new Date(Date.UTC(2026, 9, 14, 9, 42))
const req = (stayId: string, destinationBedId: string | null = null, reason = 'Closer to my new project') => ({ stayId, destinationBedId, destinationSiteId: null, reason, neededBy: null, linkedExtensionId: null })
const consent = { via: 'in_person' as const, note: null }
const swapReq = (stayId: string, otherStayId: string, extra: Record<string, unknown> = {}) => ({ stayId, otherStayId, reason: 'Friends swap', neededBy: null, consentFirst: consent, consentSecond: consent, ...extra })

const male = (staffId: string) => admin().query(`UPDATE staff_profile SET gender = 'male' WHERE id = $1`, [staffId])
const femaleOnly = (siteId: string) => admin().query(`UPDATE room SET gender_policy = 'female' WHERE site_id = $1`, [siteId])
const exceptionRows = async (transferId: string) => (await admin().query(`SELECT * FROM eligibility_exception WHERE transfer_request_id = $1 ORDER BY kind`, [transferId])).rows as Record<string, any>[]
/** The exception items of the approvals inbox for one request (the transfer's own approval items are the admins' business, shown to a Policy Approver as backup). */
const exceptionItems = async (actor: Parameters<typeof listInbox>[1], id: string) => (await listInbox(getDb(), actor, NOW_DATE())).filter(i => i.ref === id && i.kind.startsWith('transfer_exception'))
const refusalFields = (r: { ok: boolean; reason?: string; owner?: string; next?: string }) => ({ ok: r.ok, hasReason: !!r.reason, hasOwner: !!r.owner, hasNext: !!r.next })

/** A Policy Approver who is NOT an admin: a Read-only Manager role carrying the capability, scoped to the site (a capability adds the action, never the site). */
const policyApprover = (siteId: string) => person('Mgr', { siteIds: [siteId], caps: ['PolicyApprover'] })

/* ====================================================================== P-09 ====================================================================== */

describe('AT-036 P-09 (proposed, pending client sign-off): Reception raising a transfer or swap, setting OFF as shipped', () => {
  it('Reception is refused with "policy not in force: proposed, pending client sign-off", owner Accommodation Admin; nothing is stored or audited', async () => {
    const sc = await cross()
    const before = (await admin().query(`SELECT count(*)::int AS n FROM audit_event WHERE entity_type = 'transfer_request'`)).rows[0].n as number
    const r = await requestTransfer(sc.src.rec.rc, req(sc.stayId, null))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('forbidden')
    expect(r.reason).toMatch(/policy not in force: proposed, pending client sign-off/)
    expect(r.owner).toBe('Accommodation Admin')
    expect(r.next).toBe('Ask an Accommodation Admin to raise it')
    expect(r.detail).toMatchObject({ reason: 'policy_not_in_force', policy: 'P-09', setting: 'transfers.reception_may_raise' })
    expect((await admin().query(`SELECT 1 FROM transfer_request WHERE stay_id = $1`, [sc.stayId])).rowCount).toBe(0)
    expect((await admin().query(`SELECT count(*)::int AS n FROM audit_event WHERE entity_type = 'transfer_request'`)).rows[0].n).toBeGreaterThanOrEqual(before) // a refusal writes none of its own
    expect((await auditRows(sc.stayId)).filter(a => a.action.startsWith('stays.transfer'))).toHaveLength(0)
  })

  it('a swap raised by Reception is refused the same way; the same Reception cannot find a swap partner either', async () => {
    const sc = await twoStays()
    const rec = await person('Rec', { siteIds: [sc.src.siteId] })
    const r = await requestSwap(rec.rc, swapReq(sc.a.stayId, sc.b.stayId))
    expect(!r.ok && r.reason).toMatch(/policy not in force: proposed, pending client sign-off/)
    expect(!r.ok && r.owner).toBe('Accommodation Admin')
    expect((await admin().query(`SELECT 1 FROM transfer_request WHERE stay_id = $1`, [sc.a.stayId])).rowCount).toBe(0)
  })

  it('a Reception person of another site reads as "not found" (scope first, then the proposal), and the resident and the Accommodation Admin are not affected', async () => {
    const sc = await cross()
    const other = await person('Rec', { siteIds: [sc.third.siteId] })
    const r = await requestTransfer(other.rc, req(sc.stayId, null))
    expect(!r.ok && r.code).toBe('not_found')
    expect((await requestTransfer(sc.res.rc, req(sc.stayId, sc.src.bedIds[1]))).ok).toBe(true) // the resident asks for themselves, as always
    const sc2 = await cross()
    expect((await requestTransfer(sc2.src.aa.rc, req(sc2.stayId, sc2.src.bedIds[1]))).ok).toBe(true) // the Accommodation Admin raises for a resident, as always
  })

  it('Reception NEVER approves, rejects or decides: the policy table has no approval for Reception, and a Reception person cannot approve even what they hold', async () => {
    const sc = await cross()
    const rec = sc.src.rec
    for (const action of ['transfers_swaps.approve', 'approvals_inbox.decide_escalated', 'requests_waitlist.approve_exception'] as const) {
      expect(decide(rec.rc.actor, action, { siteId: sc.src.siteId }).allowed, action).toBe(false)
    }
    const id = await requested(sc)
    const approve = await approveTransfer(rec.rc, { id, destinationBedId: null, ...none })
    expect(!approve.ok && approve.code).toBe('forbidden')
    expect((await transferRow(id)).source_approved_at).toBeNull()
  })
})

describe('AT-036 D-109: whoever raised a move never approves it, whatever role or capability they hold', () => {
  it('an Accommodation Admin who raised a transfer cannot approve it (nor reject it), even though they hold the approval action', async () => {
    const sc = await cross()
    const r = await requestTransfer(sc.src.aa.rc, req(sc.stayId, sc.src.bedIds[1], 'Raised by the admin'))
    if (!r.ok) throw new Error(r.reason)
    expect(decide(sc.src.aa.rc.actor, 'transfers_swaps.approve', { siteId: sc.src.siteId }).allowed).toBe(true)
    const a = await approveTransfer(sc.src.aa.rc, { id: r.data.id, destinationBedId: null, ...none })
    expect(!a.ok && a.code).toBe('separation_of_duties')
    expect((await transferRow(r.data.id)).source_approved_at).toBeNull()
    const second = await approveTransfer(sc.srcAa2.rc, { id: r.data.id, destinationBedId: null, ...none }) // an independent admin can
    expect(second.ok).toBe(true)
  })

  it('the same holds when the raiser has no staff record to compare (the user who raised it is compared too)', async () => {
    const sc = await cross()
    const r = await requestTransfer(sc.src.aa.rc, req(sc.stayId, sc.src.bedIds[1]))
    if (!r.ok) throw new Error(r.reason)
    // The same user, acting without a staff id: the staff-id comparison alone would let them through.
    const ghost = { ...sc.src.aa.rc, actor: { ...sc.src.aa.rc.actor, staffId: undefined }, user: { ...sc.src.aa.rc.user, staffId: undefined } }
    const a = await approveTransfer(ghost, { id: r.data.id, destinationBedId: null, ...none })
    expect(!a.ok && a.code).toBe('separation_of_duties')
  })
})

/* ====================================================================== P-10 ====================================================================== */

/** The scene of the exception path: a male resident, a destination site of female-only rooms, a request for "any suitable bed". */
async function exceptionScene() {
  const sc = await cross()
  await male(sc.res.staffId)
  await femaleOnly(sc.dst.siteId)
  const id = await requested(sc, null)
  const pa = await policyApprover(sc.dst.siteId)
  return { sc, id, pa, bed: sc.dst.bedIds[1] }
}
const grant = (pa: { rc: Parameters<typeof grantTransferException>[0] }, id: string, extra: Record<string, unknown> = {}) =>
  grantTransferException(pa.rc, { transferId: id, staffId: null, kinds: ['gender'], reason: 'Needed on site for the project', evidence: 'HR memo of 12 October', confirmPassword: PASSWORD, ...extra } as Parameters<typeof grantTransferException>[1])

describe('AT-036 P-10 (proposed, pending client sign-off): a Policy Approver exception for ONE transfer destination, setting ON as shipped', () => {
  it('refused with reason, owner and next action; asked for explicitly; waits as "waiting for a Policy Approver exception"; granted with evidence; approved; executed; the use is recorded', async () => {
    const { sc, id, pa, bed } = await exceptionScene()
    expect((await approveTransfer(sc.src.aa.rc, { id, destinationBedId: null, ...none })).ok).toBe(true)

    // 1. the destination Accommodation Admin picks a bed the person may not have: refused, and the refusal says an exception can be asked for
    const refused = await approveTransfer(sc.dst.aa.rc, { id, destinationBedId: bed, ...none })
    expect(!refused.ok && refused.detail).toMatchObject({ reason: 'not_eligible', exceptionable: true, canAskException: true })
    expect(!refused.ok && refused.owner).toBe('Policy Approver')
    expect(!refused.ok && refused.next).toMatch(/exception/)
    expect((await transferRow(id)).destination_approved_at).toBeNull()
    expect((await transferRow(id)).to_bed_id).toBeNull()

    // 2. asked for explicitly: the bed is recorded, the destination key is NOT given, and the Policy Approvers are told once
    const asked = await approveTransfer(sc.dst.aa.rc, { id, destinationBedId: bed, askException: true, ...none })
    expect(asked.ok && asked.data).toMatchObject({ status: 'requested', waitingForException: true, keys: { source: true, destination: false } })
    expect(await transferRow(id)).toMatchObject({ to_bed_id: bed, destination_approved_at: null, status: 'requested' })
    expect((await auditRows(id)).map(a => a.action)).toContain('stays.transfer.exception_needed')
    const told = (await notificationsFor(id)).filter(n => n.kind === 'transfer.exception_needed')
    expect(told.map(n => n.to_role)).toEqual(['PolicyApprover'])
    expect(told[0].text).toMatch(/pending client sign-off/)

    // 3. shown as waiting: the card (reason, owner, next action) and the Policy Approver's inbox of the DESTINATION site
    const card = (await listTransfers(pa.rc.actor, { status: 'open' }, NOW_DATE())).find(t => t.id === id)!
    expect(card.exceptions).toMatchObject([{ state: 'waiting', failed: ['gender'], siteId: sc.dst.siteId, viewerCanDecide: true }])
    expect(card.waiting?.text).toMatch(/Waiting for a Policy Approver exception/)
    expect(card.waiting?.owner).toContain(sc.dst.name)
    expect(card.waiting?.next).toMatch(/pending client sign-off/)
    const inbox = (await exceptionItems(pa.rc.actor, id))
    expect(inbox.map(i => [i.kind, i.siteId, i.mine])).toEqual([['transfer_exception', sc.dst.siteId, true]])
    expect(inbox[0].title).toMatch(/gender exception/)
    const elsewhere = await policyApprover(sc.src.siteId)
    expect((await exceptionItems(elsewhere.rc.actor, id))).toEqual([]) // the source site's Policy Approver has no say here

    // 4. the destination admin still cannot approve the bed meanwhile
    const meanwhile = await approveTransfer(sc.dst.aa.rc, { id, destinationBedId: null, ...none })
    expect(!meanwhile.ok && meanwhile.detail).toMatchObject({ reason: 'not_eligible' })

    // 5. granted: an eligibility_exception row for THIS transfer, with reason, evidence, the destination site, the grantor
    const g = await grant(pa, id)
    expect(g.ok, JSON.stringify(g)).toBe(true)
    const rows = await exceptionRows(id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ staff_id: sc.res.staffId, kind: 'gender', site_id: sc.dst.siteId, request_id: null, granted_by: pa.userId, reason: 'Needed on site for the project', evidence: 'HR memo of 12 October', revoked_at: null })
    expect((await auditRows(id)).find(a => a.action === 'stays.transfer.exception.granted')).toMatchObject({ actor_role: 'Mgr', reason: 'Needed on site for the project' })
    expect((await exceptionItems(pa.rc.actor, id))).toEqual([]) // nothing left for them to decide
    expect((await notificationsFor(id)).some(n => n.kind === 'transfer.exception_granted' && n.to_role === 'AA')).toBe(true)

    // 6. approved by the destination admin, executed by Reception; the exception was honoured and every use is recorded
    const approved = await approveTransfer(sc.dst.aa.rc, { id, destinationBedId: null, ...none })
    expect(approved.ok && approved.data.status, JSON.stringify(approved)).toBe('approved')
    const done = await executeTransfer(sc.dst.rec.rc, { id })
    expect(done.ok, JSON.stringify(done)).toBe(true)
    expect((await stayRow(sc.stayId)).bed_id).toBe(bed)
    const uses = (await admin().query(`SELECT used_for, used_ref, used_by FROM eligibility_exception_use WHERE exception_id = $1`, [rows[0].id])).rows
    expect(uses).toEqual([{ used_for: 'transfer', used_ref: id, used_by: sc.dst.rec.userId }])
  })

  it('the exception counts for that ONE transfer: not for another transfer, a request, a check-in or a plain eligibility check of the same person', async () => {
    const { sc, id, pa, bed } = await exceptionScene()
    await approveTransfer(sc.src.aa.rc, { id, destinationBedId: null, ...none })
    await approveTransfer(sc.dst.aa.rc, { id, destinationBedId: bed, askException: true, ...none })
    expect((await grant(pa, id)).ok).toBe(true)
    const db = getDb()
    const now = NOW_DATE()
    expect((await checkEligibility(db, sc.res.staffId, bed, now, { transferId: id }))?.ok).toBe(true)
    expect((await checkEligibility(db, sc.res.staffId, bed, now))?.ok).toBe(false)
    expect((await checkEligibility(db, sc.res.staffId, bed, now, { transferId: crypto.randomUUID() }))?.ok).toBe(false)
    expect((await checkEligibility(db, sc.res.staffId, bed, now, { requestId: crypto.randomUUID() }))?.ok).toBe(false)
    // another transfer of the same person: cancel this one, ask for another bed: the exception does not follow
    const first = await cancelRequest(sc.res.rc, { kind: 'transfer', id, note: null })
    expect(first.ok, JSON.stringify(first)).toBe(true)
    const second = await requestTransfer(sc.res.rc, xreq(sc.stayId, null, sc.dst.siteId))
    if (!second.ok) throw new Error(second.reason)
    expect(second.data.id).not.toBe(id)
    expect((await checkEligibility(db, sc.res.staffId, bed, now, { transferId: second.data.id }))?.ok).toBe(false)
    expect((await exceptionNeeds(db, (await loadTransfer(db as never, second.data.id, false))!, now)).length).toBe(0) // no bed chosen yet, so nothing to decide
  })

  it('the guards: reason AND evidence are mandatory, the password is re-confirmed, never the person moving nor whoever raised it', async () => {
    const { sc, id, pa, bed } = await exceptionScene()
    await approveTransfer(sc.src.aa.rc, { id, destinationBedId: null, ...none })
    await approveTransfer(sc.dst.aa.rc, { id, destinationBedId: bed, askException: true, ...none })

    // reason and evidence (the route parses with this schema, so a blank never reaches the command)
    const base = { transferId: id, staffId: null, kinds: ['gender'], reason: 'Needed', evidence: 'Memo', confirmPassword: PASSWORD }
    expect(grantInput.safeParse(base).success).toBe(true)
    expect(grantInput.safeParse({ ...base, evidence: '' }).success).toBe(false)
    expect(grantInput.safeParse({ ...base, evidence: '  ' }).success).toBe(false)
    expect(grantInput.safeParse({ ...base, reason: '' }).success).toBe(false)
    expect(grantInput.safeParse({ ...base, kinds: [] }).success).toBe(false)
    expect(declineInput.safeParse({ transferId: id, reason: '' }).success).toBe(false)

    // password: missing, wrong
    const missing = await grant(pa, id, { confirmPassword: undefined })
    expect(!missing.ok && missing.fields).toMatchObject({ confirmPassword: 'Required' })
    const wrong = await grant(pa, id, { confirmPassword: 'not-my-password' })
    expect(!wrong.ok && wrong.fields).toMatchObject({ confirmPassword: 'Wrong password' })
    expect(await exceptionRows(id)).toHaveLength(0)

    // the person who would move, even holding the capability at the destination site
    const moving = as(sc.res, 'Mgr', { siteIds: [sc.dst.siteId], caps: ['PolicyApprover'] })
    const self = await grant(moving, id)
    expect(!self.ok && self.code).toBe('separation_of_duties')

    // whoever raised it: an admin of both sites holding the capability, who raised the transfer for the resident
    const raiserSc = await cross()
    await male(raiserSc.res.staffId); await femaleOnly(raiserSc.dst.siteId)
    const raiser = await person('AA', { siteIds: [raiserSc.src.siteId, raiserSc.dst.siteId], caps: ['PolicyApprover'] })
    const rr = await requestTransfer(raiser.rc, req(raiserSc.stayId, null))
    if (!rr.ok) throw new Error(rr.reason)
    const mine = await grant(raiser, rr.data.id)
    expect(!mine.ok && mine.code).toBe('separation_of_duties')
    expect(!mine.ok && mine.reason).toMatch(/raised|about you/)

    // scope: a Policy Approver of another site reads as not found; someone without the capability is forbidden; an admin is not a Policy Approver
    const stranger = await policyApprover(sc.src.siteId)
    const out = await grant(stranger, id)
    expect(!out.ok && out.code).toBe('not_found')
    const noCap = await grant(sc.dst.aa, id)
    expect(!noCap.ok && noCap.code).toBe('forbidden')
    expect(await exceptionRows(id)).toHaveLength(0)
  })

  it('a rule that does not fail cannot be waived; a left employee is never exceptionable; retrying a grant is harmless', async () => {
    const { sc, id, pa, bed } = await exceptionScene()
    await approveTransfer(sc.src.aa.rc, { id, destinationBedId: null, ...none })
    await approveTransfer(sc.dst.aa.rc, { id, destinationBedId: bed, askException: true, ...none })
    const grade = await grant(pa, id, { kinds: ['grade'] })
    expect(!grade.ok && grade.fields).toMatchObject({ kinds: expect.stringMatching(/gender/) })
    expect((await grant(pa, id)).ok).toBe(true)
    const again = await grant(pa, id)
    expect(again.ok && again.message).toBe('Already granted.')
    expect(await exceptionRows(id)).toHaveLength(1)

    // a left employee: never exceptionable, in the check and in the command
    const left = await exceptionScene()
    await admin().query(`UPDATE staff_profile SET employment_status = 'left' WHERE id = $1`, [left.sc.res.staffId])
    const e = await checkEligibility(getDb(), left.sc.res.staffId, left.bed, NOW_DATE())
    expect(e?.exceptionable).toBe(false)
    const refused = await grant(left.pa, left.id)
    expect(!refused.ok && refused.detail).toMatchObject({ reason: 'not_exceptionable' })
    expect(await exceptionRows(left.id)).toHaveLength(0)
  })

  it('declined: remembered for that person and bed, off the Policy Approver\'s inbox, shown to the destination admin; another bed asks again; no exception exists', async () => {
    const { sc, id, pa, bed } = await exceptionScene()
    await approveTransfer(sc.src.aa.rc, { id, destinationBedId: null, ...none })
    await approveTransfer(sc.dst.aa.rc, { id, destinationBedId: bed, askException: true, ...none })

    const noPassword = await declineTransferException(pa.rc, { transferId: id, staffId: null, reason: 'Not justified' })
    expect(!noPassword.ok && noPassword.fields).toMatchObject({ confirmPassword: 'Required' })
    const d = await declineTransferException(pa.rc, { transferId: id, staffId: null, reason: 'The project has housing already', confirmPassword: PASSWORD })
    expect(d.ok, JSON.stringify(d)).toBe(true)
    expect((await declineTransferException(pa.rc, { transferId: id, staffId: null, reason: 'The project has housing already', confirmPassword: PASSWORD })).ok).toBe(true) // a retry
    expect((await admin().query(`SELECT decision, reason, decided_by FROM transfer_exception_decision WHERE transfer_request_id = $1`, [id])).rows).toEqual([{ decision: 'declined', reason: 'The project has housing already', decided_by: pa.userId }])
    expect(await exceptionRows(id)).toHaveLength(0)
    expect((await auditRows(id)).map(a => a.action)).toContain('stays.transfer.exception.declined')

    expect((await exceptionItems(pa.rc.actor, id))).toEqual([])
    const card = (await listTransfers(sc.dst.aa.rc.actor, { status: 'open' }, NOW_DATE())).find(t => t.id === id)!
    expect(card.exceptions[0]).toMatchObject({ state: 'declined', declinedReason: 'The project has housing already' })
    expect(card.waiting?.owner).toContain(sc.dst.name)
    // it is append-only: the application cannot edit or delete a decision
    const forged = await admin().query(`UPDATE transfer_exception_decision SET reason = 'x' WHERE transfer_request_id = $1`, [id]).then(() => 'edited', () => 'refused')
    expect(forged).toBe('refused')

    // a granting after a decline is impossible for the same bed (nothing left to waive? it still fails the rule): the Policy Approver may still grant it
    // later (a decision can be revisited by a Policy Approver) - but another bed is asked about afresh
    const mixed = sc.dst.bedIds[2]
    await admin().query(`UPDATE room SET gender_policy = 'any' WHERE id = (SELECT room_id FROM bed WHERE id = $1)`, [mixed])
    const other = await approveTransfer(sc.dst.aa.rc, { id, destinationBedId: mixed, ...none })
    expect(other.ok && other.data.status).toBe('approved')
  })

  it('a destination that fails at EXECUTION (eligibility changed after approval) is "waiting for a Policy Approver exception" too: failed, nothing moved, granted, approved again, done', async () => {
    const w = await world({ beds: 4 })
    const aa2 = await person('AA', { siteIds: [w.siteId] })
    const pa = await policyApprover(w.siteId)
    const [res] = await residents(1)
    await male(res.staffId)
    const s = await mkStay({ bedId: w.bedIds[0], staffId: res.staffId, from: day(-3), to: day(40) })
    const r = await requestTransfer(res.rc, req(s.stayId, w.bedIds[1]))
    if (!r.ok) throw new Error(r.reason)
    const id = r.data.id
    expect((await approveTransfer(w.aa.rc, { id, destinationBedId: null, ...none })).ok).toBe(true)
    await admin().query(`UPDATE room SET gender_policy = 'female' WHERE id = (SELECT room_id FROM bed WHERE id = $1)`, [w.bedIds[1]])
    const before = { stay: await stayRow(s.stayId), beds: [await bedState(w.bedIds[0]), await bedState(w.bedIds[1])] }
    const out = await executeTransfer(w.rec.rc, { id })
    expect(!out.ok && out.detail).toMatchObject({ reason: 'not_eligible', executionFailed: true })
    expect({ stay: await stayRow(s.stayId), beds: [await bedState(w.bedIds[0]), await bedState(w.bedIds[1])] }).toEqual(before)
    const card = (await listTransfers(pa.rc.actor, { status: 'open' }, NOW_DATE())).find(t => t.id === id)!
    expect(card.status).toBe('failed')
    expect(card.exceptions).toMatchObject([{ state: 'waiting', failed: ['gender'] }])
    expect((await exceptionItems(pa.rc.actor, id)).map(i => i.kind)).toEqual(['transfer_exception'])

    expect((await grant(pa, id)).ok).toBe(true)
    expect((await approveTransfer(aa2.rc, { id, destinationBedId: null, ...none })).ok).toBe(true)
    const again = await executeTransfer(w.rec.rc, { id })
    expect(again.ok, JSON.stringify(again)).toBe(true)
    expect((await stayRow(s.stayId)).bed_id).toBe(w.bedIds[1])
  })

  it('a swap: each direction is its own decision at its own site; both exceptions recorded as uses of the swap; the swap cannot be approved before they are decided', async () => {
    const sc = await twoStays()
    await male(sc.ra.staffId)
    await male(sc.rb.staffId)
    await femaleOnly(sc.dst.siteId)  // A (from the source site) cannot move into B's room
    await femaleOnly(sc.src.siteId)  // and B cannot move into A's room
    const c = { via: 'in_person' as const, note: null }
    const refused = await requestSwap(sc.src.aa.rc, swapReq(sc.a.stayId, sc.b.stayId))
    expect(!refused.ok && refused.detail).toMatchObject({ reason: 'not_eligible', exceptionable: true, canAskException: true })
    const asked = await requestSwap(sc.src.aa.rc, swapReq(sc.a.stayId, sc.b.stayId, { askException: true, consentFirst: c, consentSecond: c }))
    if (!asked.ok) throw new Error(asked.reason)
    expect(asked.data).toMatchObject({ crossSite: true, waitingForException: true })
    const id = asked.data.id

    // not approvable yet, by either site
    const early = await approveTransfer(sc.srcAa2.rc, { id, destinationBedId: null, ...none })
    expect(!early.ok && early.detail).toMatchObject({ reason: 'waiting_for_exception' })

    const paDst = await policyApprover(sc.dst.siteId), paSrc = await policyApprover(sc.src.siteId)
    const inboxDst = await exceptionItems(paDst.rc.actor, id)
    const inboxSrc = await exceptionItems(paSrc.rc.actor, id)
    expect(inboxDst.map(i => [i.kind, i.siteId])).toEqual([['transfer_exception', sc.dst.siteId]])
    expect(inboxSrc.map(i => [i.kind, i.siteId])).toEqual([['transfer_exception_other', sc.src.siteId]])
    // the Policy Approver of the destination site cannot decide the other direction (scope is that person's OWN destination site)
    const wrongSite = await grant(paDst, id, { staffId: sc.rb.staffId })
    expect(!wrongSite.ok && wrongSite.code).toBe('not_found')

    // each grants theirs (no need to say whose: only one of the two is within their scope)
    expect((await grant(paDst, id)).ok).toBe(true)
    const midway = await approveTransfer(sc.srcAa2.rc, { id, destinationBedId: null, ...none })
    expect(!midway.ok && midway.detail).toMatchObject({ reason: 'waiting_for_exception' }) // B's direction is still open
    expect((await grant(paSrc, id)).ok).toBe(true)
    const rows = await exceptionRows(id)
    expect(rows.map(r => [r.staff_id, r.site_id])).toEqual(expect.arrayContaining([[sc.ra.staffId, sc.dst.siteId], [sc.rb.staffId, sc.src.siteId]]))

    // both sites approve, Reception swaps; every use is recorded against the swap
    expect((await approveTransfer(sc.srcAa2.rc, { id, destinationBedId: null, ...none })).ok).toBe(true)
    expect((await approveTransfer(sc.dstAa2.rc, { id, destinationBedId: null, ...none })).ok).toBe(true)
    const rec = await person('Rec', { siteIds: [sc.src.siteId] })
    const done = await executeTransfer(rec.rc, { id })
    expect(done.ok, JSON.stringify(done)).toBe(true)
    const uses = (await admin().query(`SELECT used_for, used_ref FROM eligibility_exception_use WHERE exception_id = ANY($1::uuid[])`, [rows.map(r => r.id)])).rows
    expect(uses).toEqual([{ used_for: 'swap', used_ref: id }, { used_for: 'swap', used_ref: id }])
    expect((await stayRow(sc.a.stayId)).bed_id).toBe(sc.dst.bedIds[0])
    expect((await stayRow(sc.b.stayId)).bed_id).toBe(sc.src.bedIds[0])
  })
})

/* ====================================================================== P-11, OFF as shipped ====================================================================== */

describe('AT-036 P-11 (proposed, pending client sign-off): a swap partner by employee ID, setting OFF as shipped', () => {
  it('the lookup and the swap by employee ID are refused with "policy not in force"; today\'s way (the other stay id) still works across sites; nothing is revealed, nothing counted', async () => {
    const sc = await twoStays()
    const who = (await admin().query<{ employee_id: string }>(`SELECT employee_id FROM staff_profile WHERE id = $1`, [sc.rb.staffId])).rows[0].employee_id
    const look = await lookupSwapPartner(sc.src.aa.rc, { employeeId: who })
    expect(!look.ok && look.reason).toMatch(/policy not in force: proposed, pending client sign-off/)
    expect(!look.ok && look.owner).toBe('Accommodation Admin')
    expect(JSON.stringify(look)).not.toContain(sc.rb.user.username)
    expect((await admin().query(`SELECT 1 FROM login_attempt WHERE username_norm = $1`, [`swaplookup:${sc.src.aa.userId}`])).rowCount).toBe(0)

    const byId = await requestSwap(sc.src.aa.rc, { ...swapReq(sc.a.stayId, sc.b.stayId), otherStayId: undefined, otherEmployeeId: who } as Parameters<typeof requestSwap>[1])
    expect(!byId.ok && byId.reason).toMatch(/policy not in force/)
    expect((await admin().query(`SELECT 1 FROM transfer_request WHERE stay_id = $1`, [sc.a.stayId])).rowCount).toBe(0)

    const classic = await requestSwap(sc.src.aa.rc, swapReq(sc.a.stayId, sc.b.stayId) as Parameters<typeof requestSwap>[1])
    expect(classic.ok && classic.data.crossSite).toBe(true) // as before: the other stay id came from a list
  })
})

/* ====================================================================== P-12, cancel as shipped ====================================================================== */

describe('AT-036 P-12 (proposed, pending client sign-off): future bookings after a cross-site move, "cancel" as shipped', () => {
  it('stray bookings are cancelled, closed and withdrawn; nothing dangles: no live reservation, hold, entry or offer remains; it is audited', async () => {
    const sc = await cross()
    const rv = await mkReservation({ bedId: sc.dst.bedIds[2], staffId: sc.res.staffId, from: day(40), to: day(60) })
    const entry = (await admin().query<{ id: string }>(
      `INSERT INTO waitlist_entry (staff_id, site_id, expires_at, arrival_date, end_date, stay_type, status) VALUES ($1, $2, $3, $4, $5, 'contract', 'offered') RETURNING id`,
      [sc.res.staffId, sc.src.siteId, day(15), day(5), day(65)])).rows[0].id
    const hold = (await admin().query<{ id: string }>(`INSERT INTO bed_claim (bed_id, kind, period) VALUES ($1, 'offer_hold', $2::daterange) RETURNING id`, [sc.src.bedIds[2], `[${day(5)},${day(65)})`])).rows[0].id
    await admin().query(`INSERT INTO bed_offer (staff_id, waitlist_entry_id, bed_id, claim_id, status) VALUES ($1, $2, $3, $4, 'pending')`, [sc.res.staffId, entry, sc.src.bedIds[2], hold])

    const id = await requested(sc)
    await approvedByBoth(sc, id)
    expect((await executeTransfer(sc.src.rec.rc, { id })).ok).toBe(true)

    const q = async (sql: string) => (await admin().query(sql, [sc.res.staffId])).rows
    expect(await q(`SELECT 1 FROM reservation WHERE staff_id = $1 AND status = 'reserved'`)).toHaveLength(0)
    expect(await q(`SELECT 1 FROM bed_offer WHERE staff_id = $1 AND status = 'pending'`)).toHaveLength(0)
    expect(await q(`SELECT 1 FROM waitlist_entry WHERE staff_id = $1 AND status <> 'closed'`)).toHaveLength(0)
    expect(await liveClaims(sc.dst.bedIds[2])).toHaveLength(0)
    expect(await liveClaims(sc.src.bedIds[2])).toHaveLength(0)
    const ex = (await auditRows(id)).find(a => a.action === 'stays.transfer.executed')!
    expect(ex.after.followUps.future_bookings).toMatchObject({ mode: 'cancel', reservationsCancelled: 1, waitlistEntriesClosed: 1 })
    expect((await admin().query(`SELECT status FROM bed_offer WHERE staff_id = $1`, [sc.res.staffId])).rows.map(r => r.status)).not.toContain('pending')
    expect((await auditRows(rv.reservationId)).map(a => a.action)).toContain('stays.transfer.booking_cancelled')
    expect((await admin().query(`SELECT kind FROM notification WHERE ref_id = $1`, [rv.reservationId])).rows.map(n => n.kind)).toContain('reservation.cancelled')
    // review mode's notice does not exist in cancel mode
    expect((await admin().query(`SELECT 1 FROM notification WHERE dedupe_key LIKE $1`, [`transfer:${id}:future_bookings:%`])).rowCount).toBe(0)
  })
})
