import { accommodationAdmin, admin, call, closeAll, makeUser, newSite, signedIn, superAdmin, useClock } from './helpers'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { GET as me } from '../../../app/api/v1/auth/me/route'
import { getDb } from '@/server/db/client'
import { buildActor, loadAccess } from '@/server/auth/actor'
import { can, decide } from '@/server/policy'

afterAll(closeAll)
let clock: ReturnType<typeof useClock>
beforeEach(() => { clock = useClock() })

const HOUR = 3_600_000
const iso = (ms: number) => new Date(clock.nowMs() + ms).toISOString()
const caps = async (cookie: string) => (await call(me, { cookie })).body.data.capabilities as string[]
const grantRow = async (id: string) => (await admin().query(`SELECT * FROM capability_grant WHERE id = $1`, [id])).rows[0]

describe('capability grants use maker-checker (D-22, D-27)', () => {
  it('the maker files a request that grants nothing; the same Super Admin cannot decide it; a different one approves and it takes effect', async () => {
    const sa1 = await superAdmin(), sa2 = await superAdmin()
    const holder = await signedIn({ roles: [{ role: 'Res' }] })
    const filed = await sa1.api.post('grants', { body: { userId: holder.user.id, capability: 'BackupApprover', reason: 'Named backup for the east block' } })
    expect(filed.status).toBe(200)
    const id = filed.body.data.grantId
    expect(await caps(holder.cookie)).toEqual([])
    expect(await grantRow(id)).toMatchObject({ status: 'pending', maker_id: sa1.user.id, checker_id: null })

    const self = await sa1.api.post('grants/[id]/decide', { params: { id }, body: { decision: 'approve' } })
    expect(self.status).toBe(403)
    expect(self.body.code).toBe('separation_of_duties')
    expect(self.body.next).toMatch(/another Super Admin/)
    expect((await grantRow(id)).status).toBe('pending')

    const ok = await sa2.api.post('grants/[id]/decide', { params: { id }, body: { decision: 'approve', note: 'Agreed' } })
    expect(ok.status).toBe(200)
    expect(ok.body.data.status).toBe('active')
    expect(await grantRow(id)).toMatchObject({ status: 'active', checker_id: sa2.user.id })
    expect(await caps(holder.cookie)).toEqual(['BackupApprover']) // in effect on the very next request, no new sign-in needed
    const ev = await admin().query(`SELECT action, actor_user_id, reason FROM audit_event WHERE entity_id = $1 ORDER BY seq`, [id])
    expect(ev.rows.map(e => e.action)).toEqual(['access.grant.requested', 'access.grant.approved'])
    expect(ev.rows[0].reason).toBe('Named backup for the east block')
    expect(ev.rows.map(e => e.actor_user_id)).toEqual([sa1.user.id, sa2.user.id])
  })

  it('a reason is required, and so are sensible dates', async () => {
    const sa = await superAdmin()
    const holder = await makeUser({ roles: [{ role: 'Res' }] })
    const post = (body: Record<string, unknown>) => sa.api.post('grants', { body: { userId: holder.id, capability: 'NightKeys', reason: 'Night shift', ...body } })
    expect((await post({ reason: '' })).status).toBe(422)
    expect((await post({ reason: undefined })).status).toBe(422)
    expect((await post({ capability: 'Root' })).status).toBe(422)
    expect((await post({ expiresAt: iso(-HOUR) })).status).toBe(422) // already past
    expect((await post({ startsAt: iso(2 * HOUR), expiresAt: iso(HOUR) })).status).toBe(422) // ends before it starts
    expect((await post({ expiresAt: 'next week' })).status).toBe(422)
    const bad = await post({ expiresAt: iso(-HOUR) })
    expect(bad.body.fields.expiresAt).toBeTruthy()
  })

  it('an expired grant does not reach the actor, and neither does one that has not started yet', async () => {
    const sa1 = await superAdmin(), sa2 = await superAdmin()
    const holder = await signedIn({ roles: [{ role: 'Res' }] })
    const approve = async (body: Record<string, unknown>) => {
      const id = (await sa1.api.post('grants', { body: { userId: holder.user.id, reason: 'Cover', ...body } })).body.data.grantId
      expect((await sa2.api.post('grants/[id]/decide', { params: { id }, body: { decision: 'approve' } })).status).toBe(200)
      return id as string
    }
    await approve({ capability: 'OutageExport', expiresAt: iso(HOUR) })
    await approve({ capability: 'NightKeys', startsAt: iso(2 * HOUR) })
    expect(await caps(holder.cookie)).toEqual(['OutageExport']) // NightKeys approved but not started

    clock.advance(90 * 60_000)
    expect(await caps(holder.cookie)).toEqual([]) // OutageExport ended at +1h; NightKeys starts at +2h
    clock.advance(40 * 60_000)
    expect(await caps(holder.cookie)).toEqual(['NightKeys']) // now started
  })

  it('a rejected grant never activates, the database refuses to reopen it, and it cannot be approved later', async () => {
    const sa1 = await superAdmin(), sa2 = await superAdmin()
    const holder = await signedIn({ roles: [{ role: 'Res' }] })
    const id = (await sa1.api.post('grants', { body: { userId: holder.user.id, capability: 'PolicyApprover', reason: 'Wants to approve exceptions' } })).body.data.grantId
    expect((await sa2.api.post('grants/[id]/decide', { params: { id }, body: { decision: 'reject' } })).status).toBe(422) // needs a reason
    const r = await sa2.api.post('grants/[id]/decide', { params: { id }, body: { decision: 'reject', note: 'Needs the HR Head, not this person' } })
    expect(r.status).toBe(200)
    expect(r.body.data.status).toBe('rejected')
    expect(await grantRow(id)).toMatchObject({ status: 'rejected', checker_id: sa2.user.id })
    expect(await caps(holder.cookie)).toEqual([])
    expect((await sa2.api.post('grants/[id]/decide', { params: { id }, body: { decision: 'approve' } })).status).toBe(409)
    expect((await sa1.api.post('grants/[id]/revoke', { params: { id }, body: { reason: 'x' } })).status).toBe(409)
    await expect(admin().query(`UPDATE capability_grant SET status = 'active' WHERE id = $1`, [id])).rejects.toMatchObject({ code: 'GH001' })
    expect(await caps(holder.cookie)).toEqual([])
    const ev = await admin().query(`SELECT action, reason FROM audit_event WHERE entity_id = $1 ORDER BY seq`, [id])
    expect(ev.rows.map(e => e.action)).toEqual(['access.grant.requested', 'access.grant.rejected'])
    expect(ev.rows[1].reason).toBe('Needs the HR Head, not this person')
  })

  it('nobody decides their own grant: the holder is refused even when a colleague filed it', async () => {
    const sa1 = await superAdmin(), sa2 = await superAdmin()
    const id = (await sa1.api.post('grants', { body: { userId: sa2.user.id, capability: 'Housekeeping', reason: 'Covers the cleaning rota' } })).body.data.grantId
    const mine = await sa2.api.post('grants/[id]/decide', { params: { id }, body: { decision: 'approve' } })
    expect(mine.status).toBe(403)
    expect(mine.body.code).toBe('separation_of_duties')
    expect(mine.body.reason).toMatch(/your own account/)
    expect((await grantRow(id)).status).toBe('pending')
  })

  it('a grant that ran out before approval cannot be approved', async () => {
    const sa1 = await superAdmin(), sa2 = await superAdmin()
    const holder = await makeUser({ roles: [{ role: 'Res' }] })
    const id = (await sa1.api.post('grants', { body: { userId: holder.id, capability: 'NightKeys', reason: 'One night', expiresAt: iso(HOUR) } })).body.data.grantId
    clock.advance(2 * HOUR)
    const sa3 = await superAdmin() // the others' admin sessions went idle in the meantime
    const r = await sa3.api.post('grants/[id]/decide', { params: { id }, body: { decision: 'approve' } })
    expect(r.status).toBe(409)
    expect(r.body.reason).toMatch(/ran out/)
    expect(r.body.next).toBeTruthy()
  })

  it('revoking takes effect on the holder\'s next request; a request still waiting can be withdrawn; any Super Admin may do either', async () => {
    const sa1 = await superAdmin(), sa2 = await superAdmin()
    const holder = await signedIn({ roles: [{ role: 'Res' }] })
    const id = (await sa1.api.post('grants', { body: { userId: holder.user.id, capability: 'StaffMaster', reason: 'Helps HR' } })).body.data.grantId
    await sa2.api.post('grants/[id]/decide', { params: { id }, body: { decision: 'approve' } })
    expect(await caps(holder.cookie)).toEqual(['StaffMaster'])
    expect((await sa1.api.post('grants/[id]/revoke', { params: { id }, body: {} })).status).toBe(422) // reason required
    const r = await sa1.api.post('grants/[id]/revoke', { params: { id }, body: { reason: 'Role finished' } })
    expect(r.status).toBe(200)
    expect(r.body.data.was).toBe('active')
    expect(await caps(holder.cookie)).toEqual([])
    expect(await grantRow(id)).toMatchObject({ status: 'revoked' })
    expect((await grantRow(id)).revoked_at).not.toBeNull()
    expect((await sa1.api.post('grants/[id]/revoke', { params: { id }, body: { reason: 'again' } })).status).toBe(409)
    expect((await sa2.api.post('grants/[id]/decide', { params: { id }, body: { decision: 'approve' } })).status).toBe(409) // revoked is final

    const pending = (await sa1.api.post('grants', { body: { userId: holder.user.id, capability: 'StaffMaster', reason: 'Asked again' } })).body.data.grantId
    const w = await sa2.api.post('grants/[id]/revoke', { params: { id: pending }, body: { reason: 'Withdrawn: not needed' } })
    expect(w.body.data.was).toBe('pending')
    expect((await sa2.api.post('grants/[id]/decide', { params: { id: pending }, body: { decision: 'approve' } })).status).toBe(409)
  })

  it('a capability adds actions, never scope: the holder acts only inside the sites their own role gives them', async () => {
    const sa1 = await superAdmin(), sa2 = await superAdmin()
    const mine = await newSite(), other = await newSite()
    const aa = await signedIn({ roles: [{ role: 'AA', siteId: mine }] })
    const res = await signedIn({ roles: [{ role: 'Res' }] })
    const grant = async (userId: string) => {
      const id = (await sa1.api.post('grants', { body: { userId, capability: 'BuildingCreation', reason: 'Block setup' } })).body.data.grantId
      await sa2.api.post('grants/[id]/decide', { params: { id }, body: { decision: 'approve' } })
    }
    await grant(aa.user.id)
    await grant(res.user.id)
    const now = clock.now()
    const aaActor = buildActor(await loadAccess(getDb(), aa.user.id, now), 'AA', aa.user.staffId)
    expect(aaActor.caps).toEqual(['BuildingCreation'])
    expect(aaActor.sites).toEqual([mine]) // the grant did not add a site
    expect(can(aaActor, 'sites_buildings.create_building', { siteId: mine })).toBe(true)
    expect(can(aaActor, 'sites_buildings.create_building', { siteId: other })).toBe(false)
    expect(decide(aaActor, 'sites_buildings.create_building', { siteId: other })).toMatchObject({ allowed: false, reason: 'out_of_scope' })

    const resActor = buildActor(await loadAccess(getDb(), res.user.id, now), 'Res', res.user.staffId)
    expect(resActor.sites).toEqual([])
    expect(can(resActor, 'sites_buildings.create_building', { siteId: mine })).toBe(false) // the holder has no site at all
  })

  it('warns when the capability would have no site to work in; needs an active account that holds some role; no duplicates', async () => {
    const sa1 = await superAdmin(), sa2 = await superAdmin()
    const res = await makeUser({ roles: [{ role: 'Res' }] })
    const w = await sa1.api.post('grants', { body: { userId: res.id, capability: 'FinalInspection', reason: 'Inspector' } })
    expect(w.status).toBe(200)
    expect(w.body.data.warnings.join(' ')).toMatch(/no site scope/)
    const hk = await sa1.api.post('grants', { body: { userId: res.id, capability: 'Housekeeping', reason: 'Cleaner' } })
    expect(hk.body.data.warnings).toEqual([]) // job-scoped: no site needed

    expect((await sa1.api.post('grants', { body: { userId: res.id, capability: 'FinalInspection', reason: 'again' } })).status).toBe(409) // already waiting
    await sa2.api.post('grants/[id]/decide', { params: { id: w.body.data.grantId }, body: { decision: 'approve' } })
    const held = await sa1.api.post('grants', { body: { userId: res.id, capability: 'FinalInspection', reason: 'again' } })
    expect(held.status).toBe(409)
    expect(held.body.reason).toMatch(/already holds/)

    const noRole = await makeUser({})
    const nr = await sa1.api.post('grants', { body: { userId: noRole.id, capability: 'NightKeys', reason: 'x' } })
    expect(nr.status).toBe(409)
    expect(nr.body.reason).toMatch(/no role yet/)
    const gone = await makeUser({ roles: [{ role: 'Res' }], status: 'revoked' })
    expect((await sa1.api.post('grants', { body: { userId: gone.id, capability: 'NightKeys', reason: 'x' } })).status).toBe(409)
    expect((await sa1.api.post('grants', { body: { userId: crypto.randomUUID(), capability: 'NightKeys', reason: 'x' } })).status).toBe(404)
  })

  it('only a Super Admin files, decides or revokes grants; the inbox lists what waits', async () => {
    const site = await newSite()
    const sa1 = await superAdmin(), sa2 = await superAdmin()
    const holder = await makeUser({ roles: [{ role: 'Res' }] })
    const id = (await sa1.api.post('grants', { body: { userId: holder.id, capability: 'NightKeys', reason: 'Gate' } })).body.data.grantId
    for (const role of ['AA', 'Rec', 'Aud', 'Mgr', 'Sec'] as const) {
      const u = await signedIn({ roles: [{ role, siteId: site }] })
      expect((await u.api.post('grants', { body: { userId: holder.id, capability: 'NightKeys', reason: 'x' } })).status, role).toBe(403)
      expect((await u.api.post('grants/[id]/decide', { params: { id }, body: { decision: 'approve' } })).status, role).toBe(403)
      expect((await u.api.post('grants/[id]/revoke', { params: { id }, body: { reason: 'x' } })).status, role).toBe(403)
    }
    const mine = (await sa1.api.get('approvals')).body.data.grants.find((g: { id: string }) => g.id === id)
    expect(mine).toMatchObject({ capability: 'NightKeys', mine: true, canDecide: false, targetUsername: holder.username })
    expect((await sa2.api.get('approvals')).body.data.grants.find((g: { id: string }) => g.id === id)).toMatchObject({ canDecide: true })
    const detail = await sa2.api.get('users/[id]', { params: { id: holder.id } })
    expect(detail.body.data.grants).toEqual([expect.objectContaining({ id, state: 'pending', makerUsername: sa1.user.username })])
  })
})

describe('grant states as shown on the user page', () => {
  it('labels pending, scheduled, active, expired, rejected and revoked correctly', async () => {
    const sa1 = await superAdmin(), sa2 = await superAdmin()
    const holder = await makeUser({ roles: [{ role: 'Res' }] })
    const file = async (cap: string, extra: Record<string, unknown> = {}) =>
      (await sa1.api.post('grants', { body: { userId: holder.id, capability: cap, reason: 'r', ...extra } })).body.data.grantId as string
    const decide2 = (id: string, body: Record<string, unknown>) => sa2.api.post('grants/[id]/decide', { params: { id }, body })
    const pending = await file('NightKeys')
    const scheduled = await file('OutageExport', { startsAt: iso(5 * HOUR) })
    await decide2(scheduled, { decision: 'approve' })
    const active = await file('StaffMaster')
    await decide2(active, { decision: 'approve' })
    const expiring = await file('Housekeeping', { expiresAt: iso(HOUR) })
    await decide2(expiring, { decision: 'approve' })
    const rejected = await file('PolicyApprover')
    await decide2(rejected, { decision: 'reject', note: 'no' })
    const revoked = await file('BackupApprover')
    await decide2(revoked, { decision: 'approve' })
    await sa1.api.post('grants/[id]/revoke', { params: { id: revoked }, body: { reason: 'done' } })
    clock.advance(2 * HOUR)
    const sa3 = await superAdmin()
    const states = Object.fromEntries((await sa3.api.get('users/[id]', { params: { id: holder.id } })).body.data.grants.map((g: { id: string; state: string }) => [g.id, g.state]))
    expect(states).toEqual({ [pending]: 'pending', [scheduled]: 'scheduled', [active]: 'active', [expiring]: 'expired', [rejected]: 'rejected', [revoked]: 'revoked' })
  })
})
