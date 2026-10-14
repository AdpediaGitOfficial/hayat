/**
 * AT-036 through the real route handlers: the Policy Approver's exception for a transfer (P-10, proposed, pending client sign-off) and
 * the swap-partner lookup (P-11, proposed, pending client sign-off). The permission contract test covers every role against each guard;
 * here the bodies, the password, the scope and the answers a person sees.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { admin, call, closeAll, PASSWORD } from '../harness'
import { actor } from '../fixtures2'
import { transferRow } from './helpers'
import { approveTransfer } from '@/server/commands/stays/decideTransfer'
import { cross, requested, twoStays } from './crossHelpers'
import { POST as grantRoute } from '../../../app/api/v1/stays/transfers/[id]/exception/grant/route'
import { POST as declineRoute } from '../../../app/api/v1/stays/transfers/[id]/exception/decline/route'
import { POST as lookupRoute } from '../../../app/api/v1/stays/swap-partner/route'
import { POST as swapsRoute } from '../../../app/api/v1/stays/swaps/route'
import { POST as approveRoute } from '../../../app/api/v1/stays/transfers/[id]/approve/route'

afterAll(closeAll)
const none = { note: null }

async function waiting() {
  const sc = await cross()
  await admin().query(`UPDATE staff_profile SET gender = 'male' WHERE id = $1`, [sc.res.staffId])
  await admin().query(`UPDATE room SET gender_policy = 'female' WHERE site_id = $1`, [sc.dst.siteId])
  const id = await requested(sc, null)
  await approveTransfer(sc.src.aa.rc, { id, destinationBedId: null, ...none })
  const asked = await approveTransfer(sc.dst.aa.rc, { id, destinationBedId: sc.dst.bedIds[1], askException: true, ...none })
  if (!asked.ok) throw new Error(asked.reason)
  return { sc, id }
}
const post = (h: Parameters<typeof call>[0], cookie: string | undefined, id: string, body: unknown) =>
  call(h, { method: 'POST', body, cookie, params: { id }, path: `/api/v1/stays/transfers/${id}/exception` })

describe('AT-036 P-10 through the routes: grant and decline', () => {
  it('a Policy Approver of the destination site grants with reason, evidence and their password; the answers say what happened', async () => {
    const { sc, id } = await waiting()
    const pa = await actor('Mgr', { siteIds: [sc.dst.siteId], caps: ['PolicyApprover'] })
    expect((await post(grantRoute, undefined, id, {})).status).toBe(401)
    const body = { kinds: ['gender'], reason: 'Needed on site for the project', evidence: 'HR memo of 12 October', confirmPassword: PASSWORD }
    // validation comes first: evidence and reason are mandatory
    const noEvidence = await post(grantRoute, pa.cookie, id, { ...body, evidence: '' })
    expect(noEvidence.status).toBe(422)
    expect(noEvidence.body.fields).toMatchObject({ evidence: expect.any(String) })
    expect((await post(grantRoute, pa.cookie, id, { ...body, reason: '' })).status).toBe(422)
    // the password
    const wrong = await post(grantRoute, pa.cookie, id, { ...body, confirmPassword: 'nope-nope-nope' })
    expect(wrong.status).toBe(422)
    expect(wrong.body.fields).toMatchObject({ confirmPassword: 'Wrong password' })
    expect((await admin().query(`SELECT 1 FROM eligibility_exception WHERE transfer_request_id = $1`, [id])).rowCount).toBe(0)
    // the grant
    const ok = await post(grantRoute, pa.cookie, id, body)
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    expect(ok.body.data).toMatchObject({ transferId: id, staffId: sc.res.staffId })
    expect(ok.body.message).toMatch(/this move only/)
    expect((await admin().query(`SELECT evidence, reason, site_id FROM eligibility_exception WHERE transfer_request_id = $1`, [id])).rows).toEqual([{ evidence: 'HR memo of 12 October', reason: 'Needed on site for the project', site_id: sc.dst.siteId }])
  })

  it('who is turned away: a resident (403), an admin who is not a Policy Approver (403), a Policy Approver of another site (404), the person moving (403)', async () => {
    const { sc, id } = await waiting()
    const body = { kinds: ['gender'], reason: 'Needed on site', evidence: 'Memo', confirmPassword: PASSWORD }
    const res = await actor('Res')
    expect((await post(grantRoute, res.cookie, id, body)).status).toBe(403)
    const aa = await actor('AA', { siteIds: [sc.dst.siteId] })
    expect((await post(grantRoute, aa.cookie, id, body)).status).toBe(403)
    const elsewhere = await actor('Mgr', { siteIds: [sc.src.siteId], caps: ['PolicyApprover'] })
    expect((await post(grantRoute, elsewhere.cookie, id, body)).status).toBe(404)
    expect((await admin().query(`SELECT 1 FROM eligibility_exception WHERE transfer_request_id = $1`, [id])).rowCount).toBe(0)
  })

  it('decline needs a reason and the password, writes a decision, and the answer for a repeated decline is the same', async () => {
    const { sc, id } = await waiting()
    const pa = await actor('Mgr', { siteIds: [sc.dst.siteId], caps: ['PolicyApprover'] })
    expect((await post(declineRoute, pa.cookie, id, { reason: '', confirmPassword: PASSWORD })).status).toBe(422)
    expect((await post(declineRoute, pa.cookie, id, { reason: 'Not justified' })).status).toBe(422)
    const ok = await post(declineRoute, pa.cookie, id, { reason: 'The project has housing already', confirmPassword: PASSWORD })
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    expect((await post(declineRoute, pa.cookie, id, { reason: 'The project has housing already', confirmPassword: PASSWORD })).status).toBe(200)
    expect((await admin().query(`SELECT count(*)::int AS n FROM transfer_exception_decision WHERE transfer_request_id = $1`, [id])).rows[0].n).toBe(1)
    expect((await transferRow(id)).status).toBe('requested') // a decision on the exception never decides the move
  })

  it('the destination admin can ask for the exception through the approve route, and the refusal tells the screen it may (canAskException)', async () => {
    const sc = await cross()
    await admin().query(`UPDATE staff_profile SET gender = 'male' WHERE id = $1`, [sc.res.staffId])
    await admin().query(`UPDATE room SET gender_policy = 'female' WHERE site_id = $1`, [sc.dst.siteId])
    const id = await requested(sc, null)
    await approveTransfer(sc.src.aa.rc, { id, destinationBedId: null, ...none })
    const dstAa = await actor('AA', { siteIds: [sc.dst.siteId] })
    const refused = await post(approveRoute, dstAa.cookie, id, { destinationBedId: sc.dst.bedIds[1] })
    expect(refused.status).toBe(409)
    expect(refused.body.detail).toMatchObject({ reason: 'not_eligible', canAskException: true })
    const asked = await post(approveRoute, dstAa.cookie, id, { destinationBedId: sc.dst.bedIds[1], askException: true })
    expect(asked.status, JSON.stringify(asked.body)).toBe(200)
    expect(asked.body.data).toMatchObject({ waitingForException: true, status: 'requested' })
  })
})

describe('AT-036 P-11 through the routes, setting OFF as shipped', () => {
  it('the lookup answers "policy not in force" to an admin and 403 to a resident; the swap route refuses a resident and a Reception person with a reason; nothing is revealed', async () => {
    const sc = await twoStays()
    const aa = await actor('AA', { siteIds: [sc.src.siteId] })
    const res = await actor('Res')
    const rec = await actor('Rec', { siteIds: [sc.src.siteId] })
    expect((await call(lookupRoute, { method: 'POST', body: { employeeId: 'E1' }, path: '/api/v1/stays/swap-partner' })).status).toBe(401)
    expect((await call(lookupRoute, { method: 'POST', body: { employeeId: '' }, cookie: aa.cookie, path: '/api/v1/stays/swap-partner' })).status).toBe(422)
    const off = await call(lookupRoute, { method: 'POST', body: { employeeId: 'E1' }, cookie: aa.cookie, path: '/api/v1/stays/swap-partner' })
    expect(off.status).toBe(403)
    expect(off.body.reason).toMatch(/policy not in force: proposed, pending client sign-off/)
    expect(off.body.owner).toBe('Accommodation Admin')
    expect((await call(lookupRoute, { method: 'POST', body: { employeeId: 'E1' }, cookie: res.cookie, path: '/api/v1/stays/swap-partner' })).status).toBe(403)
    const swap = { stayId: sc.a.stayId, otherStayId: sc.b.stayId, reason: 'Friends swap', neededBy: null }
    const asRec = await call(swapsRoute, { method: 'POST', body: swap, cookie: rec.cookie, path: '/api/v1/stays/swaps' })
    expect(asRec.status).toBe(403) // with P-09 off, Reception is refused (the guard lets it through to the command, which says why)
    expect((await call(swapsRoute, { method: 'POST', body: swap, cookie: res.cookie, path: '/api/v1/stays/swaps' })).status).toBe(403)
  })
})
