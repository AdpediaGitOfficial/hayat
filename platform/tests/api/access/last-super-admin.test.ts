/**
 * D-27: the last active Super Admin can never be removed or deactivated, even by two simultaneous requests.
 * Runs in a private database: "the last active Super Admin" is a global count the shared test database cannot give.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { acc, createIsolated, signIn, useClock } from './isolated'
import { deactivateAccount } from '@/server/commands/access/deactivate-account'
import { decideRoleChange } from '@/server/commands/access/decide-role-change'
import { getDb } from '@/server/db/client'
import { activeSuperAdminIds, lastSuperAdminFailure, lockSuperAdmins } from '@/server/commands/access/guards'
import { systemClock } from '@/server/clock'
import type { RequestContext } from '@/server/command/context'

const iso = await createIsolated()
afterAll(() => iso.close())
beforeEach(async () => { useClock(); await iso.retireSuperAdmins() })

type U = Awaited<ReturnType<typeof iso.makeUser>>
const sa = (status = 'active') => iso.makeUser({ roles: [{ role: 'SA', all: true }], status })

/** A request context as if this Super Admin were acting (their session is not needed to exercise the command). */
const rcOf = (u: U): RequestContext => ({
  actor: { role: 'SA', caps: [], sites: 'all', staffId: u.staffId },
  user: { id: u.id, username: u.username, staffId: u.staffId }, requestId: 'test', clock: systemClock,
})
const deactivate = (by: U, target: U) => deactivateAccount(rcOf(by), { userId: target.id, reason: 'test' })
const saAssignment = async (u: U) => (await iso.admin.query<{ id: string }>(`SELECT id FROM role_assignment WHERE user_id = $1 AND role = 'SA' AND revoked_at IS NULL`, [u.id])).rows[0].id

describe('the last active Super Admin is protected', () => {
  it('cannot be deactivated, and an invited Super Admin who has never signed in does not count as a second one', async () => {
    const lastOne = await sa()
    const invited = await sa('invited')
    const breakGlass = await sa('invited') // an actor who is not one of the active ones (e.g. a Stage 3 process)
    expect(await iso.activeSuperAdmins()).toBe(1)
    const r = await deactivate(breakGlass, lastOne)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r).toMatchObject({ code: 'conflict', status: 409, owner: 'Super Admin' })
      expect(r.reason).toMatch(/last active Super Admin/)
      expect(r.next).toMatch(/Appoint and activate another Super Admin/)
    }
    expect((await iso.admin.query(`SELECT status FROM user_account WHERE id = $1`, [lastOne.id])).rows[0].status).toBe('active')
    expect((await iso.admin.query(`SELECT 1 FROM audit_event WHERE entity_id = $1 AND action = 'access.account.deactivated'`, [lastOne.id])).rowCount).toBe(0)

    // once a second one is active the first can go, and then the second is the last
    await iso.admin.query(`UPDATE user_account SET status = 'active' WHERE id = $1`, [invited.id])
    expect((await deactivate(breakGlass, lastOne)).ok).toBe(true)
    const again = await deactivate(breakGlass, invited)
    expect(again.ok).toBe(false)
    expect(await iso.activeSuperAdmins()).toBe(1)
  })

  it('the guard counts only active accounts that hold a global Super Admin assignment', async () => {
    const a = await sa(), plain = await iso.makeUser({ roles: [{ role: 'AA', all: true }] })
    await getDb().transaction(async tx => {
      await lockSuperAdmins(tx)
      expect(await activeSuperAdminIds(tx)).toEqual([a.id])
      expect(await lastSuperAdminFailure(tx, a.id)).toMatchObject({ code: 'conflict' })
      expect(await lastSuperAdminFailure(tx, plain.id)).toBeUndefined() // not a Super Admin: nothing to protect
    })
  })

  it('role removal is protected too: of three simultaneous approvals that would remove every Super Admin, exactly one is refused', async () => {
    const a = await sa(), b = await sa(), c = await sa()
    const s = acc(await signIn(a))
    const sb = acc(await signIn(b))
    const file = async (maker: ReturnType<typeof acc>, target: U) =>
      (await maker.post('users/[id]/role-changes', { params: { id: target.id }, body: { kind: 'remove', assignmentId: await saAssignment(target), reason: 'rotation' } })).body.data.requestId as string
    const r1 = await file(s, b)   // A asks to remove B, C approves
    const r2 = await file(s, c)   // A asks to remove C, B approves
    const r3 = await file(sb, a)  // B asks to remove A, C approves
    const results = await Promise.all([
      decideRoleChange(rcOf(c), { requestId: r1, decision: 'approve' }),
      decideRoleChange(rcOf(b), { requestId: r2, decision: 'approve' }),
      decideRoleChange(rcOf(c), { requestId: r3, decision: 'approve' }),
    ])
    expect(results.filter(r => r.ok)).toHaveLength(2)
    const refused = results.filter(r => !r.ok)
    expect(refused).toHaveLength(1)
    expect(refused[0]).toMatchObject({ code: 'conflict', reason: expect.stringMatching(/last active Super Admin/) })
    expect(await iso.activeSuperAdmins()).toBe(1)
    const pending = await iso.admin.query(`SELECT count(*)::int AS n FROM role_change_request WHERE status = 'pending'`)
    expect(pending.rows[0].n).toBe(1) // the refused one is still pending, nothing half-applied
  })

  it('two Super Admins deactivating each other at the same moment: exactly one succeeds, every time', async () => {
    for (let round = 0; round < 6; round++) {
      await iso.retireSuperAdmins()
      const a = await sa(), b = await sa()
      const [x, y] = await Promise.all([deactivate(a, b), deactivate(b, a)])
      expect([x.ok, y.ok].sort()).toEqual([false, true])
      const loser = x.ok ? y : x
      expect(loser).toMatchObject({ ok: false, code: 'conflict' })
      expect(await iso.activeSuperAdmins()).toBe(1)
    }
  })

  it('a ring of four Super Admins each deactivating the next, all at once: three succeed, one Super Admin is always left', async () => {
    const four = await Promise.all([sa(), sa(), sa(), sa()])
    const results = await Promise.all(four.map((u, i) => deactivate(u, four[(i + 1) % 4])))
    expect(results.filter(r => r.ok)).toHaveLength(3)
    expect(await iso.activeSuperAdmins()).toBe(1)
  })

  it('through the real API with real sessions: one request wins, the other is refused (409) or finds its session already ended (401)', async () => {
    const a = await sa(), b = await sa()
    const ca = acc(await signIn(a)), cb = acc(await signIn(b))
    const [x, y] = await Promise.all([
      ca.post('users/[id]/deactivate', { params: { id: b.id }, body: { reason: 'race' } }),
      cb.post('users/[id]/deactivate', { params: { id: a.id }, body: { reason: 'race' } }),
    ])
    expect([x.status, y.status].filter(s => s === 200)).toHaveLength(1)
    expect([x.status, y.status].filter(s => s !== 200)[0]).toBeOneOf([409, 401])
    expect(await iso.activeSuperAdmins()).toBe(1)
  })

  it('an Accommodation Admin can never reach a Super Admin account at all', async () => {
    const a = await sa()
    const site = await iso.newSite()
    const aa = await iso.makeUser({ roles: [{ role: 'AA', siteId: site }] })
    const c = acc(await signIn(aa))
    const r = await c.post('users/[id]/deactivate', { params: { id: a.id }, body: { reason: 'x' } })
    expect(r.status).toBe(404) // a Super Admin with a global scope shares none of the AA's sites: not even visible
    expect(await iso.activeSuperAdmins()).toBe(1)
  })
})
