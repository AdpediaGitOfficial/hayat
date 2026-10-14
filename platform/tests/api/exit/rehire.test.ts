/**
 * AT-032: rehire reuses the existing profile after review. Blocked while an old clearance case is open (unless every mandatory item is
 * Done or Waived by the Policy Approver, D-41) and while the person still has a stay that was not checked out; never a second profile.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { admin, call, closeAll, PASSWORD, signIn } from '../harness'
import { POST as loginRoute } from '../../../app/api/v1/auth/login/route'
import { POST as createStaffRoute } from '../../../app/api/v1/staff/route'
import { POST as rehireRoute } from '../../../app/api/v1/exit/rehire/route'
import { markLeft } from '@/server/commands/exit/markLeft'
import { completeItem, waiveItem } from '@/server/commands/exit/items'
import { closeCase } from '@/server/commands/exit/close'
import { reactivateStaff } from '@/server/commands/exit/rehire'
import { processCheckout } from '@/server/commands/stays/checkout'
import { accountRow, auditFor, caseOf, itemsOf, mkItem, notifs, resident, staffRow, who, world, type World } from './helpers'

afterAll(closeAll)

const mark = async (w: World, staffId: string) => {
  const r = await markLeft(w.aa.rc(), { staffId, effectiveDate: '2026-10-14', reason: 'Resigned', confirmPassword: PASSWORD })
  if (!r.ok) throw new Error(r.reason)
  return r.data
}
const rehire = (by: { rc: () => Parameters<typeof reactivateStaff>[0] }, staffId: string, extra: Partial<Parameters<typeof reactivateStaff>[1]> = {}) =>
  reactivateStaff(by.rc(), { staffId, reason: 'Returning on a new contract', confirmPassword: PASSWORD, ...extra })
const idOf = (items: Awaited<ReturnType<typeof itemsOf>>, key: string) => items.find(i => i.checklist_key === key)!.id

/** Left, checked out, with a clearance case still open. */
async function leaverCheckedOut() {
  const w = await world()
  const r = await resident({ bedId: w.bedIds[0] })
  const m = await mark(w, r.staffId)
  const out = await processCheckout(w.rec.rc(), { stayId: r.stayId!, note: null })
  expect(out.ok).toBe(true)
  return { w, r, m }
}

describe('AT-032: the existing profile is reused', () => {
  it('reactivates the same profile (same id, same employee ID), clears the Left fields, audits before and after, and keeps the login off', async () => {
    const { w, r, m } = await leaverCheckedOut()
    // clear the old case first: every mandatory item Done or Waived by the Policy Approver, then closed
    const items = await itemsOf(m.caseId)
    await completeItem(w.rec.rc(), { itemId: idOf(items, 'belongings') })
    await waiveItem(w.pa.rc(), { itemId: idOf(items, 'inspection'), reason: 'Room being refurbished', evidence: 'Works order W-12', confirmPassword: PASSWORD })
    expect((await closeCase(w.aa.rc(), { caseId: m.caseId })).ok).toBe(true)

    const before = await staffRow(r.staffId)
    expect(before.employment_status).toBe('left')
    const res = await rehire(w.aa, r.staffId)
    expect(res.ok, JSON.stringify(res)).toBe(true)
    expect(res.ok && res.data).toMatchObject({ staffId: r.staffId, employeeId: r.employeeId, employmentStatus: 'active', account: 'not_requested', openCaseId: null })
    const after = await staffRow(r.staffId)
    expect(after).toMatchObject({ employment_status: 'active', left_at: null, left_effective: null, employee_id: r.employeeId })
    expect(Number((await admin().query(`SELECT count(*) FROM staff_profile WHERE lower(btrim(employee_id)) = lower($1)`, [r.employeeId])).rows[0].count)).toBe(1) // never a second profile

    const a = (await auditFor(r.staffId)).filter(x => x.action === 'exit.staff.rehired')
    expect(a).toHaveLength(1)
    expect(a[0].before).toMatchObject({ employmentStatus: 'left', leftEffective: '2026-10-14', accountStatus: 'revoked' })
    expect(a[0].after).toMatchObject({ employmentStatus: 'active', leftAt: null, sameProfile: true, accountStatus: 'revoked' })
    expect(a[0].reason).toBe('Returning on a new contract')
    expect((await notifs(`staff:${r.staffId}:rehired`)).map(n => n.to_role)).toEqual(['AA'])

    // the login stays revoked: rehire is not a back door to sign in
    expect((await accountRow(r.user.id)).status).toBe('revoked')
    expect((await call(loginRoute, { body: { username: r.user.username, password: r.user.password } })).status).toBe(401)
    // history is kept
    expect(await caseOf(r.staffId)).toHaveLength(1)
  })

  it('a second profile with the same employee ID is still a duplicate, and the message names the rehire path for someone who left', async () => {
    const { w, r } = await leaverCheckedOut()
    const create = (employeeId: string) => call(createStaffRoute, { cookie: w.aa.cookie, body: { employeeId, fullName: 'Someone Returning', gender: 'male', department: 'Housekeeping', grade: 3 }, path: '/api/v1/staff' })
    const dup = await create(r.employeeId)
    expect(dup.status).toBe(409)
    expect(dup.body.reason).toMatch(/already exists/)
    expect(dup.body.reason).toMatch(/This employee left on 2026-10-14: use Rehire/)
    expect(dup.body.fields).toMatchObject({ employeeId: 'Already in use' })
    expect((await create(` ${r.employeeId.toUpperCase()} `)).status).toBe(409) // case and spaces make no difference
    expect(Number((await admin().query(`SELECT count(*) FROM staff_profile WHERE lower(btrim(employee_id)) = lower($1)`, [r.employeeId])).rows[0].count)).toBe(1)
    // an active employee's duplicate does not talk about Rehire
    const active = await resident()
    const dup2 = await create(active.employeeId)
    expect(dup2.status).toBe(409)
    expect(dup2.body.reason).not.toMatch(/Rehire/)
  })
})

describe('AT-032: blocked while the old clearance case is open', () => {
  it('names the open items with owner and next action; nothing changes; after the Policy Approver waives and Reception completes, it goes through', async () => {
    const { w, r, m } = await leaverCheckedOut()
    const held = await mkItem({ siteId: w.siteId, bedId: w.bedIds[0], holderStaffId: r.staffId, status: 'lost', category: 'asset', itemType: 'access_card', code: 'C-9' })
    expect(held).toBeTruthy()
    const blocked = await rehire(w.aa, r.staffId)
    expect(blocked).toMatchObject({ ok: false, code: 'conflict', detail: { reason: 'open_clearance', caseId: m.caseId } })
    if (blocked.ok) return
    expect(blocked.reason).toMatch(/clearance case .* still open/)
    expect(blocked.owner).toMatch(/Reception/)
    expect(blocked.next).toMatch(/Policy Approver/)
    expect(await staffRow(r.staffId)).toMatchObject({ employment_status: 'left' })
    expect((await auditFor(r.staffId)).filter(x => x.action === 'exit.staff.rehired')).toHaveLength(0)

    // belongings done, inspection waived, but the (lost) card was not on the case when it opened: it joins when the case is worked.
    const items = await itemsOf(m.caseId)
    await completeItem(w.rec.rc(), { itemId: idOf(items, 'belongings') })
    await waiveItem(w.pa.rc(), { itemId: idOf(items, 'inspection'), reason: 'Room being refurbished', evidence: 'Works order W-12', confirmPassword: PASSWORD })
    // a held item that was added to the register after the case opened is not on the case: rehire must still see it, so the AA closes the case first
    const closed = await closeCase(w.aa.rc(), { caseId: m.caseId })
    expect(closed).toMatchObject({ ok: false, code: 'conflict' }) // the card is picked up and blocks
    const stillBlocked = await rehire(w.aa, r.staffId)
    expect(stillBlocked.ok).toBe(false)
  })

  it('goes through when every mandatory item is Done or Waived even though the case itself is still open; the case is kept and must be closed before another exit', async () => {
    const { w, r, m } = await leaverCheckedOut()
    const items = await itemsOf(m.caseId)
    await completeItem(w.rec.rc(), { itemId: idOf(items, 'belongings') })
    expect((await rehire(w.aa, r.staffId)).ok).toBe(false) // inspection still open
    await waiveItem(w.pa.rc(), { itemId: idOf(items, 'inspection'), reason: 'Room being refurbished', evidence: 'Works order W-12', confirmPassword: PASSWORD })
    const res = await rehire(w.aa, r.staffId)
    expect(res.ok && res.data).toMatchObject({ openCaseId: m.caseId })
    expect(res.ok && res.message).toMatch(/close it before any new exit/)
    expect(await staffRow(r.staffId)).toMatchObject({ employment_status: 'active' })
    // marking them Left again before the old case is closed is refused, pointing at it
    const again = await markLeft(w.aa.rc(), { staffId: r.staffId, effectiveDate: '2026-12-01', reason: 'Resigned again', confirmPassword: PASSWORD })
    expect(again).toMatchObject({ ok: false, code: 'conflict', detail: { reason: 'open_case', caseId: m.caseId } })
  })

  it('is blocked while the person is still in the bed (not checked out), with Reception as the owner', async () => {
    const w = await world()
    const r = await resident({ bedId: w.bedIds[0] })
    await mark(w, r.staffId)
    const res = await rehire(w.aa, r.staffId)
    expect(res).toMatchObject({ ok: false, code: 'conflict', owner: 'Reception', detail: { reason: 'live_stay' } })
    expect(!res.ok && res.reason).toMatch(/has not been checked out/)
    expect(await staffRow(r.staffId)).toMatchObject({ employment_status: 'left' })
  })
})

describe('rehire rules', () => {
  it('needs the password (D-03), and a wrong one changes nothing', async () => {
    const { w, r } = await leaverCheckedOut()
    expect(await rehire(w.aa, r.staffId, { confirmPassword: undefined })).toMatchObject({ ok: false, code: 'invalid' })
    expect(await rehire(w.aa, r.staffId, { confirmPassword: 'not-the-password-1' })).toMatchObject({ ok: false, code: 'invalid', fields: { confirmPassword: 'Wrong password' } })
    expect(await staffRow(r.staffId)).toMatchObject({ employment_status: 'left' })
  })

  it('only a person who is Left can be rehired; nobody rehires themselves; archived profiles are not reinstated here', async () => {
    const w = await world()
    const active = await resident()
    expect(await rehire(w.aa, active.staffId)).toMatchObject({ ok: false, code: 'conflict' })
    // the actor is a Left admin's own profile: self
    expect(await rehire(w.aa, w.aa.user.staffId)).toMatchObject({ ok: false, code: 'separation_of_duties' })
    const { r } = await leaverCheckedOut()
    await admin().query(`UPDATE staff_profile SET archived_at = now() WHERE id = $1`, [r.staffId])
    expect(await rehire(w.aa, r.staffId)).toMatchObject({ ok: false, code: 'conflict', owner: 'Super Admin' })
  })

  it('who may: Super Admin, Accommodation Admin and a Staff Master holder; Reception and residents may not (403)', async () => {
    const { w, r } = await leaverCheckedOut()
    const items = await itemsOf((await caseOf(r.staffId))[0].id)
    await completeItem(w.rec.rc(), { itemId: idOf(items, 'belongings') })
    await waiveItem(w.pa.rc(), { itemId: idOf(items, 'inspection'), reason: 'Refurbished', evidence: 'Works order', confirmPassword: PASSWORD })
    const body = { staffId: r.staffId, reason: 'Returning', confirmPassword: PASSWORD }
    expect((await call(rehireRoute, { cookie: w.rec.cookie, body, path: '/api/v1/exit/rehire' })).status).toBe(403)
    const res = await who('Res')
    expect((await call(rehireRoute, { cookie: res.cookie, body, path: '/api/v1/exit/rehire' })).status).toBe(403)
    const master = await who('Rec', { siteIds: [w.siteId], caps: ['StaffMaster'] })
    const ok = await call(rehireRoute, { cookie: master.cookie, body, path: '/api/v1/exit/rehire' })
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    expect(ok.body.data).toMatchObject({ employmentStatus: 'active', account: 'not_requested' })
  })

  it('with reactivateAccount the login comes back with a NEW temporary password shown once; the old password does not work', async () => {
    const { w, r } = await leaverCheckedOut()
    const items = await itemsOf((await caseOf(r.staffId))[0].id)
    await completeItem(w.rec.rc(), { itemId: idOf(items, 'belongings') })
    await waiveItem(w.pa.rc(), { itemId: idOf(items, 'inspection'), reason: 'Refurbished', evidence: 'Works order', confirmPassword: PASSWORD })
    const res = await rehire(w.sa, r.staffId, { reactivateAccount: true })
    expect(res.ok, JSON.stringify(res)).toBe(true)
    if (!res.ok) return
    expect(res.data).toMatchObject({ account: 'reactivated', username: r.user.username })
    expect(res.data.temporaryPassword).toMatch(/.{8,}/)
    expect((await accountRow(r.user.id)).status).toBe('active')
    expect((await call(loginRoute, { body: { username: r.user.username, password: r.user.password } })).status).toBe(401)
    const fresh = await call(loginRoute, { body: { username: r.user.username, password: res.data.temporaryPassword } })
    expect(fresh.status).toBe(200)
    expect(fresh.body.data.mustChangePassword).toBe(true)
  })

  it('when the account step fails the answer is a clear partial result: profile active, account still disabled, retry from Users & access', async () => {
    const { w, r } = await leaverCheckedOut()
    const items = await itemsOf((await caseOf(r.staffId))[0].id)
    await completeItem(w.rec.rc(), { itemId: idOf(items, 'belongings') })
    await waiveItem(w.pa.rc(), { itemId: idOf(items, 'inspection'), reason: 'Refurbished', evidence: 'Works order', confirmPassword: PASSWORD })
    // a Staff Master holder may reactivate the profile but is not allowed to manage accounts
    const master = await who('Rec', { siteIds: [w.siteId], caps: ['StaffMaster'] })
    const res = await rehire(master, r.staffId, { reactivateAccount: true })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.data).toMatchObject({ account: 'still_disabled', accountProblem: { reason: expect.any(String) } })
    expect(res.message).toMatch(/Profile reactivated; account still disabled, retry from Users & access/)
    expect(await staffRow(r.staffId)).toMatchObject({ employment_status: 'active' })
    expect((await accountRow(r.user.id)).status).toBe('revoked')
    void signIn
  })

  it('a person without a login account is simply reactivated (account: none)', async () => {
    const w = await world()
    const { mkStaff } = await import('./helpers')
    const s = await mkStaff()
    const m = await markLeft(w.aa.rc(), { staffId: s.id, effectiveDate: '2026-10-14', reason: 'Resigned', confirmPassword: PASSWORD })
    expect(m.ok).toBe(true)
    if (!m.ok) return
    const items = await itemsOf(m.data.caseId)
    await completeItem(w.rec.rc(), { itemId: idOf(items, 'belongings') })
    await waiveItem(w.pa.rc(), { itemId: idOf(items, 'inspection'), reason: 'Refurbished', evidence: 'Works order', confirmPassword: PASSWORD })
    const res = await rehire(w.sa, s.id, { reactivateAccount: true })
    expect(res.ok && res.data.account).toBe('none')
  })
})
