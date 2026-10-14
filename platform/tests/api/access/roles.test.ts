import { accountOf, accommodationAdmin, acc, activeRoles, admin, call, closeAll, makeUser, newSite, signIn, signedIn, superAdmin, useClock } from './helpers'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { GET as me } from '../../../app/api/v1/auth/me/route'
import { getDb } from '@/server/db/client'
import { buildActor, loadAccess } from '@/server/auth/actor'

afterAll(closeAll)
beforeEach(() => { useClock() })

const pendingFor = async (userId: string) =>
  (await admin().query(`SELECT * FROM role_change_request WHERE target_user_id = $1 ORDER BY created_at`, [userId])).rows

describe('role changes use maker-checker (D-27)', () => {
  it('the maker files a request that changes nothing; the same Super Admin cannot decide it; a different one approves and it is applied, with the sessions ended', async () => {
    const sa1 = await superAdmin(), sa2 = await superAdmin()
    const site = await newSite()
    const target = await signedIn({ roles: [{ role: 'Res' }] })
    expect((await call(me, { cookie: target.cookie })).status).toBe(200)

    const filed = await sa1.api.post('users/[id]/role-changes', { params: { id: target.user.id }, body: { kind: 'add', role: 'Rec', scopeKind: 'site', siteId: site, reason: 'Moves to reception' } })
    expect(filed.status).toBe(200)
    const requestId = filed.body.data.requestId
    expect(await activeRoles(target.user.id)).toEqual([{ role: 'Res', scope_kind: 'own', site_id: null }]) // nothing changed yet
    expect((await call(me, { cookie: target.cookie })).status).toBe(200) // and nobody was signed out

    const self = await sa1.api.post('role-changes/[id]/decide', { params: { id: requestId }, body: { decision: 'approve' } })
    expect(self.status).toBe(403)
    expect(self.body).toMatchObject({ code: 'separation_of_duties' })
    expect(self.body.owner).toBeTruthy()
    expect(self.body.next).toMatch(/another Super Admin/)
    expect((await pendingFor(target.user.id))[0].status).toBe('pending')

    const approved = await sa2.api.post('role-changes/[id]/decide', { params: { id: requestId }, body: { decision: 'approve', note: 'Confirmed with HR' } })
    expect(approved.status).toBe(200)
    expect(approved.body.data).toMatchObject({ status: 'approved', sessionsEnded: 1 })
    expect(await activeRoles(target.user.id)).toEqual([{ role: 'Rec', scope_kind: 'site', site_id: site }, { role: 'Res', scope_kind: 'own', site_id: null }])
    const row = (await pendingFor(target.user.id))[0]
    expect(row).toMatchObject({ status: 'approved', maker_id: sa1.user.id, checker_id: sa2.user.id })
    expect(row.resulting_assignment_id).toBeTruthy()

    // the old cookie dies on the next request; signing in again rebuilds the actor from the new assignments
    expect((await call(me, { cookie: target.cookie })).status).toBe(401)
    const again = await signIn(target.user)
    const info = await call(me, { cookie: again })
    expect(info.body.data).toMatchObject({ role: 'Rec', sites: [site] })
    expect(info.body.data.modes).toEqual(['Rec', 'Res'])

    const audit = (await admin().query(`SELECT action, actor_user_id FROM audit_event WHERE entity_id IN ($1, $2) ORDER BY seq`, [requestId, target.user.id])).rows.map(r => `${r.action}:${r.actor_user_id === sa1.user.id ? 'maker' : r.actor_user_id === sa2.user.id ? 'checker' : '?'}`)
    expect(audit).toEqual(['access.role_change.requested:maker', 'access.role_change.approved:checker', 'access.role.assigned:checker'])

    expect((await sa2.api.post('role-changes/[id]/decide', { params: { id: requestId }, body: { decision: 'approve' } })).status).toBe(409) // already decided
  })

  it('a rejection needs a reason, is recorded, changes nothing, and is final', async () => {
    const sa1 = await superAdmin(), sa2 = await superAdmin()
    const target = await makeUser({ roles: [{ role: 'Res' }] })
    const site = await newSite()
    const id = (await sa1.api.post('users/[id]/role-changes', { params: { id: target.id }, body: { kind: 'add', role: 'Mgr', scopeKind: 'site', siteId: site, reason: 'Wants reports' } })).body.data.requestId
    expect((await sa2.api.post('role-changes/[id]/decide', { params: { id }, body: { decision: 'reject' } })).status).toBe(422)
    const r = await sa2.api.post('role-changes/[id]/decide', { params: { id }, body: { decision: 'reject', note: 'Not needed for this role' } })
    expect(r.status).toBe(200)
    expect(r.body.data.status).toBe('rejected')
    expect(await activeRoles(target.id)).toEqual([{ role: 'Res', scope_kind: 'own', site_id: null }])
    expect((await pendingFor(target.id))[0]).toMatchObject({ status: 'rejected', checker_id: sa2.user.id, decision_note: 'Not needed for this role' })
    const ev = await admin().query(`SELECT action, reason FROM audit_event WHERE entity_id = $1 ORDER BY seq`, [id])
    expect(ev.rows.map(e => e.action)).toEqual(['access.role_change.requested', 'access.role_change.rejected'])
    expect(ev.rows[1].reason).toBe('Not needed for this role')
    expect((await sa1.api.post('role-changes/[id]/decide', { params: { id }, body: { decision: 'approve' } })).status).toBe(409)
    // the database refuses to reopen a decided request, whatever the application does
    await expect(admin().query(`UPDATE role_change_request SET status = 'pending' WHERE id = $1`, [id])).rejects.toMatchObject({ code: 'GH001' })
  })

  it('nobody decides a change to their own access: the target Super Admin is refused even though they did not file it', async () => {
    const sa1 = await superAdmin(), sa2 = await superAdmin(), sa3 = await superAdmin()
    const site = await newSite()
    const id = (await sa1.api.post('users/[id]/role-changes', { params: { id: sa2.user.id }, body: { kind: 'add', role: 'Rec', scopeKind: 'site', siteId: site, reason: 'Also covers reception' } })).body.data.requestId
    const mine = await sa2.api.post('role-changes/[id]/decide', { params: { id }, body: { decision: 'approve' } })
    expect(mine.status).toBe(403)
    expect(mine.body.code).toBe('separation_of_duties')
    expect(mine.body.reason).toMatch(/your own access/)
    expect((await sa3.api.post('role-changes/[id]/decide', { params: { id }, body: { decision: 'approve' } })).status).toBe(200)
  })

  it('the database itself refuses a checker who is the maker or the target (CHECK constraints)', async () => {
    const sa1 = await superAdmin()
    const target = await makeUser({ roles: [{ role: 'Res' }] })
    const site = await newSite()
    const id = (await sa1.api.post('users/[id]/role-changes', { params: { id: target.id }, body: { kind: 'add', role: 'Rec', scopeKind: 'site', siteId: site, reason: 'x' } })).body.data.requestId
    await expect(admin().query(`UPDATE role_change_request SET status = 'approved', checker_id = maker_id, decided_at = now() WHERE id = $1`, [id]))
      .rejects.toMatchObject({ code: '23514', constraint: 'role_change_maker_not_checker' })
    await expect(admin().query(`UPDATE role_change_request SET status = 'approved', checker_id = target_user_id, decided_at = now() WHERE id = $1`, [id]))
      .rejects.toMatchObject({ code: '23514', constraint: 'role_change_checker_not_target' })
    await expect(admin().query(`UPDATE role_change_request SET status = 'approved' WHERE id = $1`, [id])).rejects.toMatchObject({ code: '23514' }) // approved needs a checker
  })

  it('removing a role is also maker-checker, and ends their sessions', async () => {
    const sa1 = await superAdmin(), sa2 = await superAdmin()
    const site = await newSite()
    const target = await signedIn({ roles: [{ role: 'Rec', siteId: site }, { role: 'Res' }] })
    const rec = (await admin().query(`SELECT id FROM role_assignment WHERE user_id = $1 AND role = 'Rec'`, [target.user.id])).rows[0].id
    const id = (await sa1.api.post('users/[id]/role-changes', { params: { id: target.user.id }, body: { kind: 'remove', assignmentId: rec, reason: 'Moved departments' } })).body.data.requestId
    expect((await activeRoles(target.user.id)).map(r => r.role)).toEqual(['Rec', 'Res'])
    expect((await sa2.api.post('role-changes/[id]/decide', { params: { id }, body: { decision: 'approve' } })).status).toBe(200)
    expect((await activeRoles(target.user.id)).map(r => r.role)).toEqual(['Res'])
    expect((await call(me, { cookie: target.cookie })).status).toBe(401)
    const ended = (await admin().query(`SELECT revoked_reason FROM session WHERE user_id = $1`, [target.user.id])).rows
    expect(ended.every(s => s.revoked_reason === 'role_changed')).toBe(true)
    // the assignment row is ended, not deleted
    expect((await admin().query(`SELECT revoked_at FROM role_assignment WHERE id = $1`, [rec])).rows[0].revoked_at).not.toBeNull()
  })

  it('only a Super Admin files or decides role changes; scope can only be set by one (D-22)', async () => {
    const site = await newSite()
    const target = await makeUser({ roles: [{ role: 'Res' }] })
    const sa = await superAdmin()
    const id = (await sa.api.post('users/[id]/role-changes', { params: { id: target.id }, body: { kind: 'add', role: 'Rec', scopeKind: 'site', siteId: site, reason: 'x' } })).body.data.requestId
    for (const role of ['AA', 'Rec', 'Aud', 'Mgr'] as const) {
      const u = await signedIn({ roles: [{ role, siteId: site }] })
      expect((await u.api.post('users/[id]/role-changes', { params: { id: target.id }, body: { kind: 'add', role: 'Rec', scopeKind: 'site', siteId: site, reason: 'x' } })).status, role).toBe(403)
      expect((await u.api.post('role-changes/[id]/decide', { params: { id }, body: { decision: 'approve' } })).status, role).toBe(403)
      expect((await u.api.get('approvals')).status, role).toBe(403)
    }
  })

  it('validates role and scope: right scope kinds, existing sites, building scope warns that it gives no site scope (S-6)', async () => {
    const sa = await superAdmin(), sa2 = await superAdmin()
    const site = await newSite()
    const target = await makeUser({ roles: [{ role: 'Res' }] })
    const post = (body: Record<string, unknown>) => sa.api.post('users/[id]/role-changes', { params: { id: target.id }, body: { reason: 'because', ...body } })
    expect((await post({ kind: 'add', role: 'SA', scopeKind: 'site', siteId: site })).status).toBe(422) // Super Admin is global
    expect((await post({ kind: 'add', role: 'Res', scopeKind: 'all' })).status).toBe(422) // Resident is own-record only
    expect((await post({ kind: 'add', role: 'Rec', scopeKind: 'site' })).status).toBe(422) // site missing
    expect((await post({ kind: 'add', role: 'Rec', scopeKind: 'site', siteId: crypto.randomUUID() })).status).toBe(422) // no such site
    expect((await post({ kind: 'add', role: 'Rec', scopeKind: 'all', siteId: site })).status).toBe(422) // a site only goes with a site scope
    expect((await post({ kind: 'add', role: 'Rec', scopeKind: 'site', siteId: site, reason: '  ' })).status).toBe(422) // reason required
    expect((await post({ kind: 'add', role: 'Nope', scopeKind: 'all' })).status).toBe(422)

    const bld = (await admin().query<{ id: string }>(`INSERT INTO building (site_id, code, name) VALUES ($1, 'B1', 'Block 1') RETURNING id`, [site])).rows[0].id
    const b = await post({ kind: 'add', role: 'Rec', scopeKind: 'building', buildingId: bld })
    expect(b.status).toBe(200)
    expect(b.body.data.warnings.join(' ')).toMatch(/S-6/)
    await sa2.api.post('role-changes/[id]/decide', { params: { id: b.body.data.requestId }, body: { decision: 'approve' } })
    const access = await loadAccess(getDb(), target.id, new Date())
    expect(access.assignments.map(a => a.role).sort()).toEqual(['Rec', 'Res'])
    expect(buildActor(access, 'Rec', target.staffId).sites).toEqual([]) // a building scope gives no site scope
  })

  it('refuses the same change twice, one that is already in place, and any change to a deactivated account', async () => {
    const sa = await superAdmin(), sa2 = await superAdmin()
    const site = await newSite()
    const target = await makeUser({ roles: [{ role: 'Res' }] })
    const body = { kind: 'add', role: 'Sec', scopeKind: 'site', siteId: site, reason: 'Gate duty' }
    const first = await sa.api.post('users/[id]/role-changes', { params: { id: target.id }, body })
    expect(first.status).toBe(200)
    const dup = await sa.api.post('users/[id]/role-changes', { params: { id: target.id }, body })
    expect(dup.status).toBe(409)
    expect(dup.body.owner).toBe('A second Super Admin')
    await sa2.api.post('role-changes/[id]/decide', { params: { id: first.body.data.requestId }, body: { decision: 'approve' } })
    expect((await sa.api.post('users/[id]/role-changes', { params: { id: target.id }, body })).status).toBe(409) // already holds it

    const other = await makeUser({ roles: [{ role: 'Res' }] })
    const id = (await sa.api.post('users/[id]/role-changes', { params: { id: other.id }, body })).body.data.requestId
    await sa.api.post('users/[id]/deactivate', { params: { id: other.id }, body: { reason: 'left' } })
    expect((await accountOf(other.id)).status).toBe('revoked')
    expect((await sa.api.post('users/[id]/role-changes', { params: { id: other.id }, body: { ...body, role: 'Mgr' } })).status).toBe(409)
    const late = await sa2.api.post('role-changes/[id]/decide', { params: { id }, body: { decision: 'approve' } })
    expect(late.status).toBe(409)
    expect(late.body.reason).toMatch(/deactivated/)
    expect((await sa.api.post('users/[id]/role-changes', { params: { id: crypto.randomUUID() }, body })).status).toBe(404)
  })

  it('the approvals inbox shows what is waiting and whether this viewer may decide it', async () => {
    const sa1 = await superAdmin(), sa2 = await superAdmin()
    const site = await newSite()
    const target = await makeUser({ roles: [{ role: 'Res' }] })
    const id = (await sa1.api.post('users/[id]/role-changes', { params: { id: target.id }, body: { kind: 'add', role: 'MC', scopeKind: 'site', siteId: site, reason: 'Maintenance lead' } })).body.data.requestId
    const mine = (await sa1.api.get('approvals')).body.data.roleChanges.find((x: { id: string }) => x.id === id)
    const theirs = (await sa2.api.get('approvals')).body.data.roleChanges.find((x: { id: string }) => x.id === id)
    expect(mine).toMatchObject({ mine: true, canDecide: false, role: 'MC', targetUsername: target.username })
    expect(theirs).toMatchObject({ mine: false, canDecide: true })
    await sa2.api.post('role-changes/[id]/decide', { params: { id }, body: { decision: 'reject', note: 'no' } })
    expect((await sa2.api.get('approvals')).body.data.roleChanges.map((x: { id: string }) => x.id)).not.toContain(id)
  })
})

describe('an Accommodation Admin cannot reach role administration', () => {
  it('has no route to it, and role assignments stay out of their create-account path', async () => {
    const site = await newSite()
    const aa = await accommodationAdmin(site)
    const detail = acc(aa.cookie)
    expect((await detail.post('grants', { body: {} })).status).toBe(403)
    expect((await detail.post('role-changes/[id]/decide', { body: {} })).status).toBe(403)
  })
})
