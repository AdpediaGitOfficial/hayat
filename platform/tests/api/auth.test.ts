import { createHash } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { admin, call, closeAll, cookieValue, grantCapability, makeUser, newSite, PASSWORD, signIn, uniq, useClock } from './harness'
import { POST as login } from '../../app/api/v1/auth/login/route'
import { POST as logout } from '../../app/api/v1/auth/logout/route'
import { GET as me } from '../../app/api/v1/auth/me/route'
import { POST as changePassword } from '../../app/api/v1/auth/change-password/route'
import { POST as switchRole } from '../../app/api/v1/auth/switch-role/route'
import { revokeAllSessions } from '@/server/auth/session'
import { getDb } from '@/server/db/client'
import { buildActor } from '@/server/auth/actor'

afterAll(closeAll)
let clock: ReturnType<typeof useClock>
beforeEach(() => { clock = useClock() })

const wrong = (u: string) => call(login, { body: { username: u, password: 'definitely-wrong-1' } })

describe('sign-in', () => {
  it('sets an HttpOnly SameSite cookie and stores only a hash of the token', async () => {
    const siteId = await newSite()
    const u = await makeUser({ roles: [{ role: 'AA', siteId }] })
    const r = await call(login, { body: { username: u.username, password: u.password } })
    expect(r.status).toBe(200)
    expect(r.body.data).toMatchObject({ role: 'AA', modes: ['AA'], mustChangePassword: false })
    expect(JSON.stringify(r.body)).not.toContain(cookieValue(r.cookies[0]).split('=')[1]) // token never in the body
    expect(r.cookies[0]).toMatch(/HttpOnly/)
    expect(r.cookies[0]).toMatch(/SameSite=Lax/)
    const token = cookieValue(r.cookies[0]).split('=')[1]
    const rows = (await admin().query(`SELECT token_hash FROM session WHERE user_id = $1`, [u.id])).rows
    expect(rows).toHaveLength(1)
    expect(rows[0].token_hash).toBe(createHash('sha256').update(token).digest('hex'))
    expect(rows[0].token_hash).not.toBe(token)
  })

  it('is case-insensitive on the username and audits the sign-in', async () => {
    const u = await makeUser({ username: uniq('Mixed'), roles: [{ role: 'SA', all: true }] })
    const r = await call(login, { body: { username: `  ${u.username.toUpperCase()} `, password: u.password } })
    expect(r.status).toBe(200)
    const a = await admin().query(`SELECT action, actor_role FROM audit_event WHERE actor_user_id = $1`, [u.id])
    expect(a.rows).toEqual([{ action: 'auth.login', actor_role: 'SA' }])
  })

  it('answers the same for a wrong password and an unknown user', async () => {
    const u = await makeUser({ roles: [{ role: 'SA', all: true }] })
    const a = await wrong(u.username)
    const b = await wrong(uniq('nobody'))
    expect(a.status).toBe(401)
    expect(b.status).toBe(401)
    expect(a.body.reason).toBe(b.body.reason)
    expect(a.cookies).toEqual([])
  })

  it('refuses revoked, archived and role-less accounts with the same generic answer or a clear one', async () => {
    const revoked = await makeUser({ roles: [{ role: 'Res' }], status: 'revoked' })
    expect((await call(login, { body: { username: revoked.username, password: revoked.password } })).status).toBe(401)
    const noRole = await makeUser({})
    const r = await call(login, { body: { username: noRole.username, password: noRole.password } })
    expect(r.status).toBe(403)
    expect(r.body.owner).toBe('Administrator')
  })

  it('locks the account after 5 failures for 15 minutes, even for the right password, then unlocks', async () => {
    const u = await makeUser({ roles: [{ role: 'AA', siteId: await newSite() }] })
    for (let i = 0; i < 5; i++) expect((await wrong(u.username)).status).toBe(401)
    const locked = await call(login, { body: { username: u.username, password: u.password } })
    expect(locked.status).toBe(429)
    expect(locked.body.reason).toMatch(/15 minutes/)
    // attempts made while locked do not extend the lock
    clock.advance(14 * 60_000)
    expect((await call(login, { body: { username: u.username, password: u.password } })).status).toBe(429)
    clock.advance(2 * 60_000)
    expect((await call(login, { body: { username: u.username, password: u.password } })).status).toBe(200)
    const audit = await admin().query(`SELECT 1 FROM audit_event WHERE action = 'auth.account_locked' AND entity_id = $1`, [u.id])
    expect(audit.rowCount).toBe(1)
  })

  it('lockout applies to unknown usernames too, so it cannot be used to find real ones', async () => {
    const name = uniq('ghost')
    for (let i = 0; i < 5; i++) await wrong(name)
    expect((await wrong(name)).status).toBe(429)
  })

  it('a success resets the failure count', async () => {
    const u = await makeUser({ roles: [{ role: 'AA', siteId: await newSite() }] })
    for (let i = 0; i < 4; i++) await wrong(u.username)
    expect((await call(login, { body: { username: u.username, password: u.password } })).status).toBe(200)
    for (let i = 0; i < 4; i++) await wrong(u.username)
    expect((await call(login, { body: { username: u.username, password: u.password } })).status).toBe(200)
  })

  it('rejects malformed bodies with field messages', async () => {
    const r = await call(login, { body: { username: '', password: '' } })
    expect(r.status).toBe(422)
    expect(Object.keys(r.body.fields)).toEqual(['username', 'password'])
  })
})

describe('sessions', () => {
  it('rejects a request with no cookie, a made-up cookie, and clears a dead one', async () => {
    expect((await call(me)).status).toBe(401)
    const r = await call(me, { cookie: 'gh_session=' + 'a'.repeat(43) })
    expect(r.status).toBe(401)
    expect(r.cookies[0]).toMatch(/Max-Age=0/)
  })

  it('staff roles expire after 30 idle minutes; activity keeps them alive', async () => {
    const u = await makeUser({ roles: [{ role: 'AA', siteId: await newSite() }] })
    const cookie = await signIn(u)
    clock.advance(20 * 60_000)
    expect((await call(me, { cookie })).status).toBe(200)
    clock.advance(20 * 60_000)
    expect((await call(me, { cookie })).status).toBe(200)
    clock.advance(31 * 60_000)
    expect((await call(me, { cookie })).status).toBe(401)
    clock.advance(-31 * 60_000)
    expect((await call(me, { cookie })).status).toBe(401) // idle expiry revokes the row; it cannot be revived
    const row = await admin().query(`SELECT revoked_reason FROM session WHERE user_id = $1`, [u.id])
    expect(row.rows[0].revoked_reason).toBe('idle')
  })

  it('residents stay signed in far longer than staff roles', async () => {
    const u = await makeUser({ roles: [{ role: 'Res' }] })
    const cookie = await signIn(u)
    clock.advance(6 * 3_600_000)
    expect((await call(me, { cookie })).status).toBe(200)
  })

  it('no session outlives its absolute limit, however active (12 h for staff roles)', async () => {
    const u = await makeUser({ roles: [{ role: 'AA', siteId: await newSite() }] })
    const cookie = await signIn(u)
    for (let i = 0; i < 28; i++) { clock.advance(25 * 60_000); expect((await call(me, { cookie })).status).toBe(200) } // 11 h 40 min
    clock.advance(25 * 60_000) // 12 h 05 min after sign-in
    expect((await call(me, { cookie })).status).toBe(401)
  })

  it('revoking all sessions (Mark as Left, deactivation) kills them on the next request', async () => {
    const u = await makeUser({ roles: [{ role: 'Res' }] })
    const a = await signIn(u)
    const b = await signIn(u)
    expect((await call(me, { cookie: a })).status).toBe(200)
    const n = await revokeAllSessions(getDb(), u.id, 'marked_left', clock.now())
    expect(n).toBe(2)
    expect((await call(me, { cookie: a })).status).toBe(401)
    expect((await call(me, { cookie: b })).status).toBe(401)
  })

  it('a user revoked after signing in is cut off at once, without touching the session row', async () => {
    const u = await makeUser({ roles: [{ role: 'Res' }] })
    const cookie = await signIn(u)
    await admin().query(`UPDATE user_account SET revoked_at = now(), status = 'revoked' WHERE id = $1`, [u.id])
    expect((await call(me, { cookie })).status).toBe(401)
  })

  it('sign-out ends the session and audits it', async () => {
    const u = await makeUser({ roles: [{ role: 'Res' }] })
    const cookie = await signIn(u)
    const r = await call(logout, { method: 'POST', cookie })
    expect(r.status).toBe(200)
    expect(r.cookies[0]).toMatch(/Max-Age=0/)
    expect((await call(me, { cookie })).status).toBe(401)
    expect((await admin().query(`SELECT 1 FROM audit_event WHERE action = 'auth.logout' AND actor_user_id = $1`, [u.id])).rowCount).toBe(1)
  })
})

describe('CSRF', () => {
  it('refuses state-changing requests from another origin or a cross-site fetch', async () => {
    const u = await makeUser({ roles: [{ role: 'Res' }] })
    const cookie = await signIn(u)
    const evil = await call(logout, { method: 'POST', cookie, headers: { origin: 'https://evil.example' } })
    expect(evil.status).toBe(403)
    expect(evil.body.code).toBe('csrf')
    const cross = await call(logout, { method: 'POST', cookie, headers: { 'sec-fetch-site': 'cross-site' } })
    expect(cross.status).toBe(403)
    const login403 = await call(login, { body: { username: 'a', password: 'b' }, headers: { origin: 'https://evil.example' } })
    expect(login403.status).toBe(403)
    expect((await call(me, { cookie })).status).toBe(200) // still signed in: the forged request did nothing
  })
})

describe('first sign-in and password change', () => {
  it('limits the session to changing the password until it is changed', async () => {
    const u = await makeUser({ roles: [{ role: 'AA', siteId: await newSite() }], mustChange: true })
    const cookie = await signIn(u)
    expect((await call(me, { cookie })).body.data.mustChangePassword).toBe(true)
    const blocked = await call(switchRole, { cookie, body: { role: 'AA' } })
    expect(blocked.status).toBe(403)
    expect(blocked.body.code).toBe('password_change_required')
    const ok = await call(changePassword, { cookie, body: { current: u.password, next: 'A-brand-new-pass-7' } })
    expect(ok.status).toBe(200)
    expect((await call(switchRole, { cookie, body: { role: 'AA' } })).status).toBe(200)
    expect((await call(me, { cookie })).body.data.mustChangePassword).toBe(false)
  })

  it('enforces the password policy and the current password', async () => {
    const u = await makeUser({ roles: [{ role: 'Res' }] })
    const cookie = await signIn(u)
    expect((await call(changePassword, { cookie, body: { current: 'nope', next: 'A-brand-new-pass-7' } })).body.fields.current).toBeDefined()
    expect((await call(changePassword, { cookie, body: { current: u.password, next: 'short' } })).status).toBe(422)
    expect((await call(changePassword, { cookie, body: { current: u.password, next: 'password123' } })).body.fields.next).toMatch(/common/)
    expect((await call(changePassword, { cookie, body: { current: u.password, next: u.username } })).status).toBe(422)
    expect((await call(changePassword, { cookie, body: { current: u.password, next: u.password } })).status).toBe(422)
  })

  it('ends the user\'s other sessions and the old password stops working', async () => {
    const u = await makeUser({ roles: [{ role: 'Res' }] })
    const phone = await signIn(u)
    const laptop = await signIn(u)
    expect((await call(changePassword, { cookie: laptop, body: { current: u.password, next: 'A-brand-new-pass-7' } })).status).toBe(200)
    expect((await call(me, { cookie: phone })).status).toBe(401)
    expect((await call(me, { cookie: laptop })).status).toBe(200)
    expect((await call(login, { body: { username: u.username, password: u.password } })).status).toBe(401)
    expect((await call(login, { body: { username: u.username, password: 'A-brand-new-pass-7' } })).status).toBe(200)
  })

  it('stores an Argon2id hash', async () => {
    const u = await makeUser({ roles: [{ role: 'Res' }] })
    const h = (await admin().query(`SELECT password_hash FROM user_account WHERE id = $1`, [u.id])).rows[0].password_hash
    expect(h).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/)
    expect(h).not.toContain(PASSWORD)
  })
})

describe('acting mode and actor', () => {
  it('a user with several roles acts as one at a time and can only switch to a role they hold', async () => {
    const siteId = await newSite()
    const u = await makeUser({ roles: [{ role: 'AA', siteId }, { role: 'Res' }] })
    const cookie = await signIn(u)
    expect((await call(me, { cookie })).body.data).toMatchObject({ role: 'AA', modes: ['AA', 'Res'], sites: [siteId] })
    expect((await call(switchRole, { cookie, body: { role: 'Res' } })).status).toBe(200)
    expect((await call(me, { cookie })).body.data).toMatchObject({ role: 'Res', sites: [] })
    const nope = await call(switchRole, { cookie, body: { role: 'SA' } })
    expect(nope.status).toBe(404)
    expect((await call(me, { cookie })).body.data.role).toBe('Res')
  })

  it('site scope is the union of site assignments; building scope gives none; "all" wins', () => {
    const a = (role: any, scopeKind: any, siteId: string | null, buildingId: string | null = null) => ({ id: uniq(), role, scopeKind, siteId, buildingId })
    const caps: any[] = []
    expect(buildActor({ assignments: [a('AA', 'site', 's1'), a('AA', 'site', 's2'), a('Rec', 'site', 's3')], caps }, 'AA').sites).toEqual(['s1', 's2'])
    expect(buildActor({ assignments: [a('AA', 'building', null, 'b1')], caps }, 'AA').sites).toEqual([])
    expect(buildActor({ assignments: [a('SA', 'all', null), a('SA', 'site', 's1')], caps }, 'SA').sites).toBe('all')
  })

  it('only active, started, unexpired capability grants reach the actor', async () => {
    const u = await makeUser({ roles: [{ role: 'AA', siteId: await newSite() }] })
    const day = 86_400_000
    await grantCapability(u.id, 'BuildingCreation')
    await grantCapability(u.id, 'NightKeys', { expiresAt: new Date(Date.now() - day) })
    await grantCapability(u.id, 'Housekeeping', { startsAt: new Date(Date.now() + day) })
    useClock(new Date())
    const cookie = await signIn(u)
    expect((await call(me, { cookie })).body.data.capabilities).toEqual(['BuildingCreation'])
  })
})
