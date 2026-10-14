/**
 * Reading cases: scope (out of scope is simply not there), open first, overdue marked, search, and what each role is offered on a case.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { admin, call, closeAll, PASSWORD } from '../harness'
import { GET as listRoute } from '../../../app/api/v1/exit/route'
import { GET as getRoute } from '../../../app/api/v1/exit/[id]/route'
import { GET as findRoute } from '../../../app/api/v1/exit/find/route'
import { markLeft } from '@/server/commands/exit/markLeft'
import { completeItem } from '@/server/commands/exit/items'
import { closeCase } from '@/server/commands/exit/close'
import { resident, itemsOf, who, world, mkItem, type World } from './helpers'

afterAll(closeAll)

const mark = async (w: World, staffId: string) => {
  const r = await markLeft(w.aa.rc(), { staffId, effectiveDate: '2026-10-14', reason: 'Resigned', confirmPassword: PASSWORD })
  if (!r.ok) throw new Error(r.reason)
  return r.data
}
const list = (cookie: string, qs = '') => call(listRoute, { cookie, path: `/api/v1/exit${qs}` })
const ids = (r: { body: { data: { id: string }[] } }) => r.body.data.map(c => c.id)

describe('the case list', () => {
  it('shows each viewer only the cases of their sites; a case with no site is open to any holder (S-8); residents are refused', async () => {
    const w = await world()
    const a = await resident({ bedId: w.bedIds[0] })
    const b = await resident({ bedId: w.other.bedIds[0] })
    const nobody = await resident()
    const ka = await mark(w, a.staffId)
    const kb = (await markLeft(w.aaOther.rc(), { staffId: b.staffId, effectiveDate: '2026-10-14', reason: 'Resigned', confirmPassword: PASSWORD }))
    const kn = await mark(w, nobody.staffId)
    expect(kb.ok).toBe(true)
    const mine = ids(await list(w.aa.cookie, '?scope=all'))
    expect(mine).toContain(ka.caseId)
    expect(mine).toContain(kn.caseId) // no site: visible to every Accommodation Admin
    expect(mine).not.toContain(kb.ok ? kb.data.caseId : '')
    const theirs = ids(await list(w.aaOther.cookie, '?scope=all'))
    expect(theirs).toContain(kb.ok ? kb.data.caseId : '')
    expect(theirs).not.toContain(ka.caseId)
    for (const p of [w.rec, w.mc, w.pa, w.sa]) expect(ids(await list(p.cookie, '?scope=all'))).toContain(ka.caseId)
    expect(ids(await list(w.sa.cookie, '?scope=all'))).toEqual(expect.arrayContaining([ka.caseId, kn.caseId, kb.ok ? kb.data.caseId : '']))
    expect((await list(a.cookie)).status).toBe(401) // the former employee's login is gone
    const stillIn = await resident()
    expect((await list(stillIn.cookie)).status).toBe(403) // a resident
  })

  it('open cases come first, overdue ones before the rest, the earliest due date first; cleared cases are shown on request; search narrows', async () => {
    const w = await world()
    const [a, b, c] = [await resident({ bedId: w.bedIds[0] }), await resident({ bedId: w.bedIds[1] }), await resident({ bedId: w.bedIds[2] })]
    const [ka, kb, kc] = [await mark(w, a.staffId), await mark(w, b.staffId), await mark(w, c.staffId)]
    await admin().query(`UPDATE clearance_case SET due_date = '2026-10-01' WHERE id = $1`, [kb.caseId]) // overdue (the test clock says 14 Oct... real clock is the same day)
    // kc is cleared
    const items = await itemsOf(kc.caseId)
    await completeItem(w.rec.rc(), { itemId: items.find(i => i.checklist_key === 'belongings')!.id })
    await completeItem(w.mc.rc(), { itemId: items.find(i => i.checklist_key === 'inspection')!.id })
    expect((await closeCase(w.aa.rc(), { caseId: kc.caseId })).ok).toBe(true)

    const open = await list(w.aa.cookie, '?q=Person')
    const mineOpen = ids(open).filter(i => [ka.caseId, kb.caseId, kc.caseId].includes(i))
    expect(mineOpen).toEqual([kb.caseId, ka.caseId]) // overdue first; cleared not in "open"
    const overdue = open.body.data.find((x: { id: string }) => x.id === kb.caseId)
    expect(overdue).toMatchObject({ overdue: true, status: 'open', pendingMandatory: 2, nextOwner: 'Reception', nextItem: 'Belongings removed from the room' })
    expect(overdue.daysOverdue).toBeGreaterThan(0)
    const all = ids(await list(w.aa.cookie, '?scope=all')).filter(i => [ka.caseId, kb.caseId, kc.caseId].includes(i))
    expect(all).toEqual([kb.caseId, ka.caseId, kc.caseId]) // cleared last
    expect(ids(await list(w.aa.cookie, '?scope=cleared')).filter(i => [ka.caseId, kb.caseId, kc.caseId].includes(i))).toEqual([kc.caseId])
    expect(ids(await list(w.aa.cookie, '?overdue=1')).filter(i => [ka.caseId, kb.caseId, kc.caseId].includes(i))).toEqual([kb.caseId])
    const byId = await list(w.aa.cookie, `?scope=all&q=${encodeURIComponent(a.employeeId)}`)
    expect(ids(byId)).toEqual([ka.caseId])
  })
})

describe('one case, as each role sees it', () => {
  it('Reception may work Reception items, the Maintenance Coordinator the inspection, the Policy Approver may waive, the Accommodation Admin may reopen and close', async () => {
    const w = await world()
    const r = await resident({ bedId: w.bedIds[0] })
    await mkItem({ siteId: w.siteId, roomId: w.roomId, holderStaffId: r.staffId, status: 'lost', category: 'asset', itemType: 'access_card', code: 'C-LIST' })
    const k = await mark(w, r.staffId)
    const get = async (cookie: string) => (await call(getRoute, { cookie, params: { id: k.caseId } })).body.data
    const itemOf = (d: { items: { label: string; me: Record<string, unknown> }[] }, label: string) => d.items.find(i => i.label.includes(label))!
    const rec = await get(w.rec.cookie), mc = await get(w.mc.cookie), pa = await get(w.pa.cookie), aa = await get(w.aa.cookie)
    expect(itemOf(rec, 'Belongings').me).toMatchObject({ canWork: true, canWaive: false, canReopen: false })
    expect(itemOf(rec, 'inspection').me).toMatchObject({ canWork: false, why: expect.stringMatching(/Maintenance Coordinator/) })
    expect(itemOf(mc, 'inspection').me).toMatchObject({ canWork: true })
    expect(itemOf(mc, 'Belongings').me).toMatchObject({ canWork: false })
    expect(itemOf(pa, 'Belongings').me).toMatchObject({ canWork: false, canWaive: true })
    expect(itemOf(pa, 'Access card').me).toMatchObject({ canWork: false, canWaive: true })
    expect(itemOf(aa, 'Belongings').me).toMatchObject({ canWork: true, canWaive: false })
    expect(itemOf(aa, 'inspection').me).toMatchObject({ canWork: false })
    expect(itemOf(aa, 'Access card')).toMatchObject({ status: 'outstanding', lostOrDamaged: true })
    expect(itemOf(aa, 'Access card').me).toMatchObject({ canWork: false, why: expect.stringMatching(/never marked returned/), owner: 'Accommodation Admin' })
    expect(aa.me).toMatchObject({ canClose: false })
    expect(rec.me).toMatchObject({ canClose: false, why: expect.stringMatching(/Accommodation Admin or a Super Admin/) })
    expect(aa.closeBlockers).toHaveLength(3)
    expect(aa.stay).toMatchObject({ stillInBed: true, status: 'active' })
    expect(aa.person).toMatchObject({ employmentStatus: 'left', accountStatus: 'revoked' })
  })

  it('the person finder for /exits/new shows the effects first, refuses to preview what the caller cannot reach, and flags the blocked states', async () => {
    const w = await world()
    const busy = await resident({ bedId: w.bedIds[0] })
    await mkItem({ siteId: w.siteId, bedId: w.bedIds[0], holderStaffId: busy.staffId, code: 'K-FIND' })
    const find = (cookie: string, emp: string) => call(findRoute, { cookie, path: `/api/v1/exit/find?employeeId=${encodeURIComponent(emp)}` })
    const ok = await find(w.aa.cookie, busy.employeeId.toLowerCase())
    expect(ok.status).toBe(200)
    expect(ok.body.data).toMatchObject({ canMark: true, person: { fullName: expect.any(String), hasAccount: true, isSelf: false }, impact: { keysHeld: 1, liveSessions: 1 } })
    expect(ok.body.data.willHappen.join(' ')).toMatch(/The stay stays: they remain in bed/)
    expect(ok.body.data.willHappen.join(' ')).toMatch(/1 key or asset still held will be added/)
    // nothing happened
    expect((await admin().query(`SELECT employment_status FROM staff_profile WHERE id = $1`, [busy.staffId])).rows[0].employment_status).toBe('active')
    expect((await find(w.aaOther.cookie, busy.employeeId)).status).toBe(404) // out of scope reads as no such person
    expect((await find(w.aa.cookie, 'NO-SUCH-ID')).status).toBe(404)
    expect((await find(w.rec.cookie, busy.employeeId)).status).toBe(403)
    const self = await find(w.aa.cookie, (await admin().query<{ employee_id: string }>(`SELECT employee_id FROM staff_profile WHERE id = $1`, [w.aa.user.staffId])).rows[0].employee_id)
    expect(self.body.data).toMatchObject({ canMark: false, blocked: { why: expect.stringMatching(/cannot mark yourself/), owner: expect.any(String), next: expect.any(String) } })
    await mark(w, busy.staffId)
    const again = await find(w.aa.cookie, busy.employeeId)
    expect(again.body.data).toMatchObject({ canMark: false, blocked: { why: expect.stringMatching(/already marked as Left/) }, existingCaseId: expect.any(String) })
    const colleague = await who('AA', { siteIds: [w.siteId] })
    const { mkStayFor } = await import('./helpers')
    await mkStayFor({ staffId: colleague.user.staffId, bedId: w.bedIds[4], from: '2026-10-01' })
    const emp = (await admin().query<{ employee_id: string }>(`SELECT employee_id FROM staff_profile WHERE id = $1`, [colleague.user.staffId])).rows[0].employee_id
    expect((await find(w.aa.cookie, emp)).body.data).toMatchObject({ canMark: false, blocked: { owner: 'Super Admin' } })
    expect((await find(w.sa.cookie, emp)).body.data).toMatchObject({ canMark: true })
  })
})
