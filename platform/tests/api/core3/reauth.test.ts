import { afterAll, describe, expect, it } from 'vitest'
import { admin, closeAll, makeUser, PASSWORD, useClock } from '../harness'
import { rcFor } from '../rc'
import { runCommand } from '@/server/command/run'
import { ok } from '@/server/command/result'
import { confirmPassword } from '@/server/auth/reauth'

afterAll(closeAll)

async function attempt(rcOf: ReturnType<typeof rcFor>, password: string | undefined) {
  return runCommand(rcOf, async c => { const d = await confirmPassword(c, password); return d ?? ok('fine') })
}

describe('confirmPassword (D-03)', () => {
  it('accepts the actor\'s own password, refuses a missing or wrong one with a field error', async () => {
    const clock = useClock('2026-10-14T09:00:00Z')
    const u = await makeUser({ roles: [{ role: 'SA', all: true }] })
    const rc = rcFor(u.id, { role: 'SA', sites: 'all' }, clock)
    expect((await attempt(rc, u.password)).ok).toBe(true)
    const none = await attempt(rc, undefined)
    expect(!none.ok && none.fields?.confirmPassword).toBe('Required')
    const bad = await attempt(rc, 'not-my-password-1')
    expect(!bad.ok && bad.fields?.confirmPassword).toBe('Wrong password')
  })

  it('is the actor\'s own password: somebody else\'s does not work', async () => {
    const clock = useClock('2026-10-14T09:00:00Z')
    const a = await makeUser({ roles: [{ role: 'SA', all: true }], password: 'Alpha-password-1!' })
    const b = await makeUser({ roles: [{ role: 'SA', all: true }], password: 'Bravo-password-2!' })
    expect((await attempt(rcFor(a.id, { role: 'SA', sites: 'all' }, clock), 'Bravo-password-2!')).ok).toBe(false)
    void b
  })

  it('wrong attempts are throttled like sign-in, and the count survives the rolled-back command', async () => {
    const clock = useClock('2026-10-14T09:00:00Z')
    const u = await makeUser({ roles: [{ role: 'SA', all: true }] })
    const rc = rcFor(u.id, { role: 'SA', sites: 'all' }, clock)
    for (let i = 0; i < 5; i++) expect((await attempt(rc, 'wrong-password-' + i)).ok).toBe(false)
    expect((await admin().query(`SELECT count(*)::int AS n FROM login_attempt WHERE username_norm = $1`, ['reauth:' + u.id])).rows[0].n).toBe(5)
    const locked = await attempt(rc, u.password)               // even the right password is refused while throttled
    expect(!locked.ok && locked.code).toBe('rate_limited')
    clock.advance(16 * 60_000)
    expect((await attempt(rc, u.password)).ok).toBe(true)
    void PASSWORD
  })
})
