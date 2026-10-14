/**
 * D-27 for Mark as Left: the last active Super Admin can never be marked as Left, even by two simultaneous requests.
 * Runs in a private database: "the last active Super Admin" is a global count the shared test database cannot give.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createIsolated, PASSWORD, useClock } from '../access/isolated'
import { markLeft } from '@/server/commands/exit/markLeft'
import { systemClock } from '@/server/clock'
import type { RequestContext } from '@/server/command/context'

const iso = await createIsolated()
afterAll(async () => {
  // pg-pool's end() resolves before the sockets are closed, and close() then drops the database WITH (FORCE): wait for the sockets first,
  // or the dying connections raise "terminating connection" as an unhandled error (a race in tests/api/access/isolated.ts).
  const end = iso.admin.end.bind(iso.admin)
  iso.admin.end = (async () => { await end(); await new Promise(r => setTimeout(r, 250)) }) as typeof iso.admin.end
  await iso.close()
})
beforeEach(async () => { useClock(); await iso.retireSuperAdmins() })

type U = Awaited<ReturnType<typeof iso.makeUser>>
const sa = (status = 'active') => iso.makeUser({ roles: [{ role: 'SA', all: true }], status })
const rcOf = (u: U): RequestContext => ({
  actor: { role: 'SA', caps: [], sites: 'all', staffId: u.staffId },
  user: { id: u.id, username: u.username, staffId: u.staffId }, requestId: 'test', clock: systemClock,
})
const left = (by: U, target: U) => markLeft(rcOf(by), { staffId: target.staffId, effectiveDate: '2026-10-14', reason: 'Resigned', confirmPassword: PASSWORD })
const status = async (u: U) => (await iso.admin.query<{ status: string }>(`SELECT status FROM user_account WHERE id = $1`, [u.id])).rows[0].status
const employment = async (u: U) => (await iso.admin.query<{ employment_status: string }>(`SELECT employment_status FROM staff_profile WHERE id = $1`, [u.staffId])).rows[0].employment_status

describe('the last active Super Admin cannot be marked as Left', () => {
  it('refuses with the same reason as deactivating, and nothing changes; with a second active Super Admin it works', async () => {
    const lastOne = await sa()
    const invited = await sa('invited') // an invited Super Admin who never signed in does not count as a second one
    expect(await iso.activeSuperAdmins()).toBe(1)
    const r = await left(invited, lastOne)
    expect(r).toMatchObject({ ok: false, code: 'conflict', owner: 'Super Admin' })
    expect(!r.ok && r.reason).toMatch(/last active Super Admin/)
    expect(await status(lastOne)).toBe('active')
    expect(await employment(lastOne)).toBe('active')
    expect((await iso.admin.query(`SELECT 1 FROM clearance_case WHERE staff_id = $1`, [lastOne.staffId])).rowCount).toBe(0)

    await iso.admin.query(`UPDATE user_account SET status = 'active' WHERE id = $1`, [invited.id])
    expect((await left(invited, lastOne)).ok).toBe(true)
    expect(await employment(lastOne)).toBe('left')
    expect(await iso.activeSuperAdmins()).toBe(1)
    // and now the other one is the last
    const again = await left(await sa('invited'), invited)
    expect(again).toMatchObject({ ok: false, code: 'conflict' })
  })

  it('two Super Admins marking each other as Left at the same moment: exactly one succeeds, every time', async () => {
    for (let round = 0; round < 6; round++) {
      await iso.retireSuperAdmins()
      const a = await sa(), b = await sa()
      const [x, y] = await Promise.all([left(a, b), left(b, a)])
      expect([x.ok, y.ok].sort()).toEqual([false, true])
      expect(await iso.activeSuperAdmins()).toBe(1)
      const loser = x.ok ? y : x
      expect(loser).toMatchObject({ ok: false, code: 'conflict' })
    }
  })

  it('a ring of four Super Admins each marking the next as Left, all at once: three succeed, one is always left', async () => {
    const four = await Promise.all([sa(), sa(), sa(), sa()])
    const results = await Promise.all(four.map((u, i) => left(u, four[(i + 1) % 4])))
    expect(results.filter(r => r.ok)).toHaveLength(3)
    expect(await iso.activeSuperAdmins()).toBe(1)
  })
})
