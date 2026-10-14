import { accountOf, accommodationAdmin, acc, activeRoles, admin, call, closeAll, cookieValue, dump, makeUser, newSite, newStaff, signIn, signedIn, superAdmin, uniq } from './helpers'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { POST as login } from '../../../app/api/v1/auth/login/route'
import { GET as me } from '../../../app/api/v1/auth/me/route'
import { POST as changePassword } from '../../../app/api/v1/auth/change-password/route'

afterAll(closeAll)

const signInWith = (username: string, password: string) => call(login, { body: { username, password } })

describe('creating an account (admin-assisted activation, D-07 / D-08)', () => {
  it('a Super Admin creates an account; the temporary password is shown once, stored only as an Argon2id hash, and works through the real sign-in', async () => {
    const logged: string[] = []
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(m => vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logged.push(a.map(String).join(' ')) }))
    try {
      const sa = await superAdmin()
      const staff = await newStaff()
      const r = await sa.api.post('users', { body: { employeeId: staff.employeeId } })
      expect(r.status).toBe(200)
      const { userId, username, temporaryPassword } = r.body.data
      expect(username).toBe(staff.employeeId) // username defaults to the employee ID (D-06)
      expect(temporaryPassword).toMatch(/^[A-Za-z0-9]{12}$/)
      expect(r.headers.get('cache-control')).toBe('no-store')
      expect(r.body.message).toMatch(/cannot be shown again/)

      // stored: Argon2id hash, forced change, invited; never the plaintext anywhere
      const row = await accountOf(userId)
      expect(row.password_hash).toMatch(/^\$argon2id\$/)
      expect(row.password_hash).not.toContain(temporaryPassword)
      expect(row.must_change_password).toBe(true)
      expect(row.status).toBe('invited')
      const everything = await dump(['audit_event', 'user_account', 'role_assignment', 'role_change_request', 'session', 'login_attempt', 'config_item', 'account_site'])
      expect(everything).not.toContain(temporaryPassword)
      const audit = (await admin().query(`SELECT action, actor_user_id, after FROM audit_event WHERE entity_id = $1 ORDER BY seq`, [userId])).rows
      expect(audit.map(a => a.action)).toEqual(['access.account.created'])
      expect(audit[0].actor_user_id).toBe(sa.user.id)
      expect(JSON.stringify(audit[0].after)).not.toMatch(/temporary|passwordHash|password_hash|argon2/i)

      // later responses never carry it again
      const detail = await sa.api.get('users/[id]', { params: { id: userId } })
      const list = await sa.api.get('users', { query: { q: staff.employeeId } })
      expect(detail.status).toBe(200)
      expect(list.body.data.rows.map((x: { id: string }) => x.id)).toContain(userId)
      expect(JSON.stringify([detail.body, list.body])).not.toContain(temporaryPassword)
      expect(JSON.stringify([detail.body, list.body])).not.toMatch(/argon2/)

      // the real sign-in route: works, and forces the change
      const first = await signInWith(username, temporaryPassword)
      expect(first.status).toBe(200)
      expect(first.body.data).toMatchObject({ mustChangePassword: true, role: 'Res' })
      const cookie = cookieValue(first.cookies[0])
      expect((await call(me, { cookie })).status).toBe(200) // allowed while must-change
      const blocked = await acc(cookie).get('users')
      expect(blocked.status).toBe(403)
      expect(blocked.body.code).toBe('password_change_required')
      const changed = await call(changePassword, { cookie, body: { current: temporaryPassword, next: 'A-fresh-pass-2026' } })
      expect(changed.status).toBe(200)
      // exactly once: the temporary password is dead now
      expect((await signInWith(username, temporaryPassword)).status).toBe(401)
      expect((await signInWith(username, 'A-fresh-pass-2026')).status).toBe(200)
      expect((await accountOf(userId)).status).toBe('active')

      expect(logged.join('\n')).not.toContain(temporaryPassword)
    } finally {
      spies.forEach(s => s.mockRestore())
    }
  })

  it('the base Resident role (own record only) comes with the account; any other role waits for a second Super Admin', async () => {
    const sa = await superAdmin()
    const staff = await newStaff()
    const site = await newSite()
    const r = await sa.api.post('users', { body: { employeeId: staff.employeeId, siteId: site, reason: 'New Reception officer', initialRole: { role: 'Rec', scopeKind: 'site', siteId: site } } })
    expect(r.status).toBe(200)
    expect(r.body.data.roleChangeRequestId).toBeTruthy()
    expect(await activeRoles(r.body.data.userId)).toEqual([{ role: 'Res', scope_kind: 'own', site_id: null }])
    const pending = await admin().query(`SELECT status, maker_id, kind, role FROM role_change_request WHERE id = $1`, [r.body.data.roleChangeRequestId])
    expect(pending.rows[0]).toMatchObject({ status: 'pending', maker_id: sa.user.id, kind: 'add', role: 'Rec' })
  })

  it('refuses a duplicate account, a taken username, a Left staff member, an unknown employee ID, and a bad site', async () => {
    const sa = await superAdmin()
    const staff = await newStaff()
    expect((await sa.api.post('users', { body: { employeeId: staff.employeeId } })).status).toBe(200)
    const again = await sa.api.post('users', { body: { employeeId: ` ${staff.employeeId.toLowerCase()} ` } }) // normalised like the business key (D-05)
    expect(again.status).toBe(409)
    expect(again.body).toMatchObject({ code: 'conflict', owner: 'Accommodation Admin' })
    expect(again.body.next).toMatch(/Reset the password or reactivate/)

    const other = await newStaff()
    const taken = await sa.api.post('users', { body: { employeeId: other.employeeId, username: staff.employeeId.toUpperCase() } })
    expect(taken.status).toBe(409)
    expect(taken.body.reason).toMatch(/username is already in use/)

    const left = await newStaff({ status: 'left' })
    const l = await sa.api.post('users', { body: { employeeId: left.employeeId } })
    expect(l.status).toBe(409)
    expect(l.body.reason).toMatch(/marked as Left/)

    const unknown = await sa.api.post('users', { body: { employeeId: uniq('NOBODY') } })
    expect(unknown.status).toBe(422)
    expect(unknown.body.fields.employeeId).toBeTruthy()

    const badSite = await sa.api.post('users', { body: { employeeId: other.employeeId, siteId: crypto.randomUUID() } })
    expect(badSite.status).toBe(404)
    expect((await sa.api.post('users', { body: {} })).status).toBe(422) // needs a staff id or an employee ID
    expect((await sa.api.post('users', { body: { employeeId: 'x', staffId: crypto.randomUUID() } })).status).toBe(422)
  })

  it('an Accommodation Admin creates staff accounts inside their own sites only, and never an administrator account', async () => {
    const mine = await newSite(), theirs = await newSite()
    const aa = await accommodationAdmin(mine)
    const staff = await newStaff()
    expect((await aa.api.post('users', { body: { employeeId: staff.employeeId } })).status).toBe(422) // site required
    const elsewhere = await aa.api.post('users', { body: { employeeId: staff.employeeId, siteId: theirs } })
    expect(elsewhere.status).toBe(404)

    const withRole = await aa.api.post('users', { body: { employeeId: staff.employeeId, siteId: mine, reason: 'x', initialRole: { role: 'SA', scopeKind: 'all' } } })
    expect(withRole.status).toBe(403)
    expect(withRole.body).toMatchObject({ code: 'forbidden', owner: 'Super Admin' })
    expect(withRole.body.next).toBeTruthy()
    expect((await admin().query(`SELECT 1 FROM user_account WHERE staff_id = $1`, [staff.id])).rowCount).toBe(0) // nothing was created

    const ok = await aa.api.post('users', { body: { employeeId: staff.employeeId, siteId: mine } })
    expect(ok.status).toBe(200)
    expect(await activeRoles(ok.body.data.userId)).toEqual([{ role: 'Res', scope_kind: 'own', site_id: null }])
    const home = await admin().query(`SELECT site_id FROM account_site WHERE user_id = $1`, [ok.body.data.userId])
    expect(home.rows).toEqual([{ site_id: mine }])
  })

  it('Reception, Residents and the Auditor cannot create accounts (403)', async () => {
    const site = await newSite()
    const staff = await newStaff()
    for (const role of ['Rec', 'Aud', 'Res'] as const) {
      const u = await signedIn({ roles: [role === 'Res' ? { role } : { role, siteId: site }] })
      expect((await u.api.post('users', { body: { employeeId: staff.employeeId, siteId: site } })).status, role).toBe(403)
    }
  })
})

describe('who may see and manage which account', () => {
  it('an Accommodation Admin sees and resets accounts in their sites; accounts elsewhere are not found; administrator accounts are refused with the owner named', async () => {
    const s1 = await newSite(), s2 = await newSite()
    const aa = await accommodationAdmin(s1)
    const sa = await superAdmin()
    const staff1 = await newStaff(), staff2 = await newStaff()
    const mineAcct = (await sa.api.post('users', { body: { employeeId: staff1.employeeId, siteId: s1 } })).body.data.userId
    const theirAcct = (await sa.api.post('users', { body: { employeeId: staff2.employeeId, siteId: s2 } })).body.data.userId

    const list = await aa.api.get('users')
    const ids = list.body.data.rows.map((r: { id: string }) => r.id)
    expect(ids).toContain(mineAcct)
    expect(ids).not.toContain(theirAcct)
    expect(list.body.data.rows.find((r: { id: string }) => r.id === mineAcct).manageable).toBe(true)

    expect((await aa.api.get('users/[id]', { params: { id: theirAcct } })).status).toBe(404)
    expect((await aa.api.post('users/[id]/reset-password', { params: { id: theirAcct } })).status).toBe(404)
    expect((await aa.api.post('users/[id]/deactivate', { params: { id: theirAcct }, body: { reason: 'x' } })).status).toBe(404)

    const ok = await aa.api.post('users/[id]/reset-password', { params: { id: mineAcct } })
    expect(ok.status).toBe(200)

    // another AA in the same site is an administrator account
    const peer = await accommodationAdmin(s1)
    const refused = await aa.api.post('users/[id]/reset-password', { params: { id: peer.user.id } })
    expect(refused.status).toBe(403)
    expect(refused.body).toMatchObject({ code: 'forbidden', owner: 'Super Admin' })
    expect(refused.body.reason).toMatch(/administrator account/)
    const deact = await aa.api.post('users/[id]/deactivate', { params: { id: peer.user.id }, body: { reason: 'x' } })
    expect(deact.status).toBe(403)
    expect((await accountOf(peer.user.id)).status).toBe('active')

    // an account that also belongs to a site outside the AA's own is a Super Admin's to manage
    await admin().query(`INSERT INTO account_site (user_id, site_id) VALUES ($1, $2)`, [mineAcct, s2])
    const wide = await aa.api.post('users/[id]/reset-password', { params: { id: mineAcct } })
    expect(wide.status).toBe(403)
    expect(wide.body.reason).toMatch(/outside yours/)
  })

  it('the Auditor can read the list but not change anything; Reception cannot even read it', async () => {
    const site = await newSite()
    const sa = await superAdmin()
    const staff = await newStaff()
    const acct = (await sa.api.post('users', { body: { employeeId: staff.employeeId, siteId: site } })).body.data.userId
    const aud = await signedIn({ roles: [{ role: 'Aud', siteId: site }] })
    expect((await aud.api.get('users')).body.data.rows.map((r: { id: string }) => r.id)).toContain(acct)
    expect((await aud.api.get('users/[id]', { params: { id: acct } })).status).toBe(200)
    expect((await aud.api.post('users/[id]/reset-password', { params: { id: acct } })).status).toBe(403)
    const rec = await signedIn({ roles: [{ role: 'Rec', siteId: site }] })
    expect((await rec.api.get('users')).status).toBe(403)
  })

  it('nobody resets, deactivates or ends the sessions of their own account (D-26)', async () => {
    const sa = await superAdmin()
    for (const [path, body] of [['users/[id]/reset-password', {}], ['users/[id]/deactivate', { reason: 'x' }], ['users/[id]/revoke-sessions', { reason: 'x' }]] as const) {
      const r = await sa.api.post(path, { params: { id: sa.user.id }, body })
      expect(r.status, path).toBe(403)
      expect(r.body.code, path).toBe('separation_of_duties')
      expect(r.body.owner).toBeTruthy()
      expect(r.body.next).toBeTruthy()
    }
    expect((await call(me, { cookie: sa.cookie })).status).toBe(200) // still signed in, still active
    expect((await sa.api.get('users/[id]', { params: { id: sa.user.id } })).body.data).toMatchObject({ self: true, manageable: false })
  })
})

describe('passwords, lockout and sessions', () => {
  it('reset shows a new temporary password once, ends every session at once, clears a lockout and forces a change', async () => {
    const sa = await superAdmin()
    const site = await newSite()
    const victim = await makeUser({ roles: [{ role: 'Rec', siteId: site }] })
    await admin().query(`INSERT INTO account_site (user_id, site_id) VALUES ($1, $2)`, [victim.id, site])
    const cookieA = await signIn(victim)
    const cookieB = await signIn(victim)
    expect((await call(me, { cookie: cookieA })).status).toBe(200)

    // lock the account with five wrong passwords
    for (let i = 0; i < 5; i++) expect((await signInWith(victim.username, 'definitely-wrong-1')).status).toBe(401)
    expect((await signInWith(victim.username, victim.password)).status).toBe(429)

    const r = await sa.api.post('users/[id]/reset-password', { params: { id: victim.id }, body: { reason: 'Forgot it' } })
    expect(r.status).toBe(200)
    expect(r.body.data.sessionsEnded).toBe(2)
    const temp: string = r.body.data.temporaryPassword
    expect(temp).toMatch(/^[A-Za-z0-9]{12}$/)
    expect((await call(me, { cookie: cookieA })).status).toBe(401) // the existing cookie dies on the next request
    expect((await call(me, { cookie: cookieB })).status).toBe(401)
    expect((await signInWith(victim.username, victim.password)).status).toBe(401) // the old password is gone
    const signedIn = await signInWith(victim.username, temp) // and the lock is cleared
    expect(signedIn.status).toBe(200)
    expect(signedIn.body.data.mustChangePassword).toBe(true)
    expect(await dump(['audit_event'])).not.toContain(temp)
    const a = (await admin().query(`SELECT action, reason, after FROM audit_event WHERE entity_id = $1 AND action = 'access.account.password_reset'`, [victim.id])).rows
    expect(a).toHaveLength(1)
    expect(a[0].reason).toBe('Forgot it')
    expect(a[0].after).toMatchObject({ sessionsEnded: 2, unlocked: true })
  })

  it('a deactivated account loses its sessions at once and cannot sign in; reactivation issues a NEW temporary password', async () => {
    const sa = await superAdmin()
    const staff = await newStaff()
    const made = (await sa.api.post('users', { body: { employeeId: staff.employeeId } })).body.data
    const s1 = await signInWith(made.username, made.temporaryPassword)
    const cookie = cookieValue(s1.cookies[0])
    expect((await call(me, { cookie })).status).toBe(200)

    expect((await sa.api.post('users/[id]/deactivate', { params: { id: made.userId }, body: {} })).status).toBe(422) // reason required
    const d = await sa.api.post('users/[id]/deactivate', { params: { id: made.userId }, body: { reason: 'Left the project' } })
    expect(d.status).toBe(200)
    expect(d.body.data.sessionsEnded).toBe(1)
    expect((await call(me, { cookie })).status).toBe(401)
    expect((await signInWith(made.username, made.temporaryPassword)).status).toBe(401)
    expect((await accountOf(made.userId)).status).toBe('revoked')
    expect((await sa.api.post('users/[id]/deactivate', { params: { id: made.userId }, body: { reason: 'again' } })).status).toBe(409)
    expect((await sa.api.post('users/[id]/reset-password', { params: { id: made.userId } })).status).toBe(409) // reactivate first

    const re = await sa.api.post('users/[id]/reactivate', { params: { id: made.userId }, body: { reason: 'Back on the project' } })
    expect(re.status).toBe(200)
    expect(re.body.data.temporaryPassword).not.toBe(made.temporaryPassword)
    expect((await signInWith(made.username, made.temporaryPassword)).status).toBe(401) // the old password does not come back
    const back = await signInWith(made.username, re.body.data.temporaryPassword)
    expect(back.status).toBe(200)
    expect(back.body.data.mustChangePassword).toBe(true)
    expect((await sa.api.post('users/[id]/reactivate', { params: { id: made.userId }, body: { reason: 'again' } })).status).toBe(409) // not deactivated
  })

  it('reactivation is refused for someone marked as Left (that is the re-hire path)', async () => {
    const sa = await superAdmin()
    const staff = await newStaff()
    const made = (await sa.api.post('users', { body: { employeeId: staff.employeeId } })).body.data
    await sa.api.post('users/[id]/deactivate', { params: { id: made.userId }, body: { reason: 'Left' } })
    await admin().query(`UPDATE staff_profile SET employment_status = 'left', left_at = now() WHERE id = $1`, [staff.id])
    const r = await sa.api.post('users/[id]/reactivate', { params: { id: made.userId }, body: { reason: 'oops' } })
    expect(r.status).toBe(409)
    expect(r.body.reason).toMatch(/marked as Left/)
    expect((await accountOf(made.userId)).status).toBe('revoked')
  })

  it('"revoke all sessions" ends every session but leaves the account usable', async () => {
    const sa = await superAdmin()
    const site = await newSite()
    const aa = await accommodationAdmin(site)
    const staff = await newStaff()
    const made = (await aa.api.post('users', { body: { employeeId: staff.employeeId, siteId: site } })).body.data
    const c1 = cookieValue((await signInWith(made.username, made.temporaryPassword)).cookies[0])
    const c2 = cookieValue((await signInWith(made.username, made.temporaryPassword)).cookies[0])
    const detail = await aa.api.get('users/[id]', { params: { id: made.userId } })
    expect(detail.body.data.liveSessionCount).toBe(2)
    const r = await aa.api.post('users/[id]/revoke-sessions', { params: { id: made.userId }, body: { reason: 'Lost phone' } })
    expect(r.status).toBe(200)
    expect(r.body.data.sessionsEnded).toBe(2)
    expect((await call(me, { cookie: c1 })).status).toBe(401)
    expect((await call(me, { cookie: c2 })).status).toBe(401)
    expect((await signInWith(made.username, made.temporaryPassword)).status).toBe(200)
    expect((await sa.api.get('users/[id]', { params: { id: made.userId } })).body.data.liveSessionCount).toBe(1)
  })
})
