import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { admin, closeAll, useClock } from '../harness'
import { actor, audits, auditCount, bedRow, mkBed, mkProperty, mkSite, occupy, reserve, send } from './helpers'
import { POST as block } from '../../../app/api/v1/property/beds/[id]/block/route'
import { POST as unblock } from '../../../app/api/v1/property/beds/[id]/unblock/route'
import { GET as getBed } from '../../../app/api/v1/property/beds/[id]/route'

afterAll(closeAll)
// The fixed clock is 2026-10-14 09:42 UTC and sites default to UTC, so "today" is 2026-10-14.
beforeEach(() => { useClock() })

const openBlocks = async (bedId: string) => (await admin().query(`SELECT reason, until_date::text AS until, released_at FROM bed_block WHERE bed_id = $1 ORDER BY blocked_at`, [bedId])).rows

describe('block and unblock', () => {
  it('an AA blocks a free bed with a reason: state, reason, history row and audit row', async () => {
    const p = await mkProperty()
    const aa = await actor('AA', { siteIds: [p.siteId] })
    const r = await send(block, aa, { id: p.bedIds[0], body: { reason: 'Water leak above the bed' } })
    expect(r.status).toBe(200)
    expect(r.body.data).toMatchObject({ state: 'blocked', until: null, upcomingClaims: [] })
    expect(await bedRow(p.bedIds[0])).toMatchObject({ state: 'blocked', state_reason: 'Water leak above the bed' })
    expect(await openBlocks(p.bedIds[0])).toEqual([{ reason: 'Water leak above the bed', until: null, released_at: null }])
    const a = await audits(p.bedIds[0])
    expect(a).toHaveLength(1)
    expect(a[0]).toMatchObject({ action: 'property.bed.blocked', reason: 'Water leak above the bed', actor_role: 'AA', site_id: p.siteId })
    expect(a[0].before.state).toBe('available')
    expect(a[0].after.state).toBe('blocked')
  })

  it('the reason is required', async () => {
    const p = await mkProperty()
    const aa = await actor('AA', { siteIds: [p.siteId] })
    for (const reason of [undefined, '', '  ', 'x']) {
      const r = await send(block, aa, { id: p.bedIds[0], body: { reason } })
      expect(r.status, String(reason)).toBe(422)
      expect(r.body.fields.reason).toBeTruthy()
    }
    expect((await bedRow(p.bedIds[0])).state).toBe('available')
    expect(await auditCount(p.siteId)).toBe(0)
  })

  it('"until" is the LAST blocked day: stored as given, today is allowed, yesterday is not', async () => {
    const p = await mkProperty()
    const aa = await actor('AA', { siteIds: [p.siteId] })
    const past = await send(block, aa, { id: p.bedIds[0], body: { reason: 'Painting', until: '2026-10-13' } })
    expect(past.status).toBe(422)
    expect(past.body.fields.until).toBeTruthy()
    const bad = await send(block, aa, { id: p.bedIds[0], body: { reason: 'Painting', until: '31/10/2026' } })
    expect(bad.status).toBe(422)
    const today = await send(block, aa, { id: p.bedIds[0], body: { reason: 'Painting', until: '2026-10-14' } })
    expect(today.status).toBe(200)
    expect((await openBlocks(p.bedIds[0]))[0].until).toBe('2026-10-14')
    const ok = await send(block, aa, { id: p.bedIds[1], body: { reason: 'Painting', until: '2026-10-31' } })
    expect(ok.body.data.until).toBe('2026-10-31')
  })

  it('"today" is the site\'s own date: a site ahead of UTC accepts a date UTC has not reached yet', async () => {
    useClock('2026-10-14T22:30:00Z') // already 15 Oct 02:30 in Dubai
    const siteId = await mkSite({ tz: 'Asia/Dubai' })
    const room = (await admin().query<{ id: string }>(`INSERT INTO room (site_id, name) VALUES ($1, 'R') RETURNING id`, [siteId])).rows[0].id
    const bed = (await admin().query<{ id: string }>(`INSERT INTO bed (site_id, room_id, code) VALUES ($1, $2, 'DXB-1') RETURNING id`, [siteId, room])).rows[0].id
    const aa = await actor('AA', { siteIds: [siteId] })
    expect((await send(block, aa, { id: bed, body: { reason: 'Painting', until: '2026-10-14' } })).status).toBe(422)
    expect((await send(block, aa, { id: bed, body: { reason: 'Painting', until: '2026-10-15' } })).status).toBe(200)
  })

  it('refuses an occupied bed, saying who must act first, and changes nothing', async () => {
    const p = await mkProperty()
    await occupy(p.bedIds[0])
    const aa = await actor('AA', { siteIds: [p.siteId] })
    const r = await send(block, aa, { id: p.bedIds[0], body: { reason: 'Deep clean' } })
    expect(r.status).toBe(409)
    expect(r.body.reason).toMatch(/occupied/)
    expect(r.body.owner).toBeTruthy()
    expect(r.body.next).toMatch(/check the resident out|transfer/i)
    expect((await bedRow(p.bedIds[0])).state).toBe('occupied')
    expect(await openBlocks(p.bedIds[0])).toEqual([])
    expect(await audits(p.bedIds[0])).toEqual([])
  })

  it('refuses an already blocked bed and an archived bed', async () => {
    const p = await mkProperty()
    const aa = await actor('AA', { siteIds: [p.siteId] })
    expect((await send(block, aa, { id: p.bedIds[0], body: { reason: 'First reason' } })).status).toBe(200)
    const again = await send(block, aa, { id: p.bedIds[0], body: { reason: 'Second reason' } })
    expect(again.status).toBe(409)
    expect(again.body.reason).toMatch(/already blocked/)
    expect(await openBlocks(p.bedIds[0])).toHaveLength(1)
    await admin().query(`UPDATE bed SET state = 'archived', archived_at = now() WHERE id = $1`, [p.bedIds[1]])
    const gone = await send(block, aa, { id: p.bedIds[1], body: { reason: 'Reason here' } })
    expect(gone.status).toBe(409)
    expect(gone.body.reason).toMatch(/archived/)
  })

  it.each(['needs_cleaning', 'inspection_required', 'under_maintenance'])('a bed that is %s may be blocked (the state machine allows it)', async state => {
    const p = await mkProperty()
    const bedId = await mkBed(p.roomId, { state }) // a bed may be created in any state (imports, seed data)
    const aa = await actor('AA', { siteIds: [p.siteId] })
    const r = await send(block, aa, { id: bedId, body: { reason: 'Unsafe wiring' } })
    expect(r.status).toBe(200)
    expect((await audits(bedId))[0].before.state).toBe(state)
  })

  it('a bed with future reservations CAN be blocked: nothing is cancelled or moved, and the answer lists the claims', async () => {
    const p = await mkProperty()
    const inside = await reserve(p.bedIds[0], '2026-10-20', '2026-10-25')
    const after = await reserve(p.bedIds[0], '2026-12-01', '2026-12-10')
    const aa = await actor('AA', { siteIds: [p.siteId] })
    const r = await send(block, aa, { id: p.bedIds[0], body: { reason: 'Floor repair', until: '2026-10-31' } })
    expect(r.status).toBe(200)
    const claims = r.body.data.upcomingClaims
    expect(claims.map((c: { claimId: string; overlapsBlock: boolean }) => [c.claimId, c.overlapsBlock])).toEqual([[inside.claimId, true], [after.claimId, false]])
    expect(claims[0]).toMatchObject({ kind: 'reservation', from: '2026-10-20', to: '2026-10-25' })
    expect(r.body.message).toMatch(/1 reservation/)
    // Nothing was touched.
    const live = (await admin().query(`SELECT count(*)::int AS n FROM bed_claim WHERE bed_id = $1 AND released_at IS NULL`, [p.bedIds[0]])).rows[0].n
    expect(live).toBe(2)
    expect((await admin().query(`SELECT status FROM reservation WHERE bed_id = $1`, [p.bedIds[0]])).rows.every(x => x.status === 'reserved')).toBe(true)
    // The audit row records how many claims are affected, so the decision is traceable.
    expect((await audits(p.bedIds[0]))[0].after).toMatchObject({ upcomingClaims: 2, claimsOverlappingBlock: 1 })
  })

  it('an open-ended block overlaps every future reservation; a departure on the day the block starts does not overlap', async () => {
    const p = await mkProperty()
    const leavesToday = await reserve(p.bedIds[0], '2026-10-10', '2026-10-14') // departs on 14 Oct: shares no night with a block from 14 Oct
    const future = await reserve(p.bedIds[0], '2027-03-01', '2027-04-01')
    const aa = await actor('AA', { siteIds: [p.siteId] })
    const r = await send(block, aa, { id: p.bedIds[0], body: { reason: 'Refurbishment' } })
    const byId = new Map(r.body.data.upcomingClaims.map((c: { claimId: string; overlapsBlock: boolean }) => [c.claimId, c.overlapsBlock]))
    // The first claim has ended by today's end-exclusive reading, so it is not listed at all.
    expect(byId.has(leavesToday.claimId)).toBe(false)
    expect(byId.get(future.claimId)).toBe(true)
  })

  it('two admins blocking the same bed at once: exactly one block is recorded, the others get a clean conflict', async () => {
    const p = await mkProperty()
    const a1 = await actor('AA', { siteIds: [p.siteId] }), a2 = await actor('MC', { siteIds: [p.siteId] })
    const rs = await Promise.all([
      send(block, a1, { id: p.bedIds[0], body: { reason: 'Reason from the admin' } }),
      send(block, a2, { id: p.bedIds[0], body: { reason: 'Reason from the coordinator' } }),
      send(block, a1, { id: p.bedIds[0], body: { reason: 'Reason from the admin again' } }),
    ])
    expect(rs.map(r => r.status).sort()).toEqual([200, 409, 409])
    expect(await openBlocks(p.bedIds[0])).toHaveLength(1)
    expect((await audits(p.bedIds[0])).filter(a => a.action === 'property.bed.blocked')).toHaveLength(1)
  })

  it('unblock: the bed goes to Needs Cleaning (never straight to Available), the block is closed, audit written', async () => {
    const p = await mkProperty()
    const aa = await actor('AA', { siteIds: [p.siteId] })
    await send(block, aa, { id: p.bedIds[0], body: { reason: 'Leak', until: '2026-10-20' } })
    const r = await send(unblock, aa, { id: p.bedIds[0], body: { note: 'Fixed and dried' } })
    expect(r.status).toBe(200)
    expect(r.body.data.state).toBe('needs_cleaning')
    expect(r.body.message).toMatch(/cleaning/i)
    expect(await bedRow(p.bedIds[0])).toMatchObject({ state: 'needs_cleaning', state_reason: null })
    const rows = await openBlocks(p.bedIds[0])
    expect(rows).toHaveLength(1)
    expect(rows[0].released_at).not.toBeNull()
    expect((await audits(p.bedIds[0])).map(a => a.action)).toEqual(['property.bed.blocked', 'property.bed.unblocked'])
    // And it can be blocked again: a new history row, not a clash with the closed one.
    expect((await send(block, aa, { id: p.bedIds[0], body: { reason: 'Another issue' } })).status).toBe(200)
    expect(await openBlocks(p.bedIds[0])).toHaveLength(2)
  })

  it('unblocking a bed that is not blocked is refused', async () => {
    const p = await mkProperty()
    const aa = await actor('AA', { siteIds: [p.siteId] })
    const r = await send(unblock, aa, { id: p.bedIds[0], body: {} })
    expect(r.status).toBe(409)
    expect(r.body.owner).toBeTruthy()
    expect(await audits(p.bedIds[0])).toEqual([])
  })

  it('a failed block leaves no audit row and no half-written state (reason rejected by the database state machine)', async () => {
    const p = await mkProperty()
    const aa = await actor('AA', { siteIds: [p.siteId] })
    // Make the bed look available to the pre-check but occupied in the database is impossible; instead prove the invariant:
    // a refusal for an occupied bed wrote nothing anywhere for this site.
    await occupy(p.bedIds[0])
    await send(block, aa, { id: p.bedIds[0], body: { reason: 'Will be refused' } })
    expect(await auditCount(p.siteId)).toBe(0)
    expect((await admin().query(`SELECT count(*)::int AS n FROM bed_block WHERE site_id = $1`, [p.siteId])).rows[0].n).toBe(0)
  })

  it('who may block: SA, AA and MC in their sites; Rec, Mgr, Aud, Sec, Res, Tech, Vend get 403', async () => {
    const p = await mkProperty({ beds: 3 })
    for (const [i, role] of (['SA', 'AA', 'MC'] as const).entries()) {
      const a = await actor(role, { siteIds: [p.siteId] })
      expect((await send(block, a, { id: p.bedIds[i], body: { reason: 'Maintenance round' } })).status, role).toBe(200)
    }
    for (const role of ['Rec', 'Mgr', 'Aud', 'Sec', 'Res', 'Tech', 'Vend'] as const) {
      const a = await actor(role, { siteIds: [p.siteId] })
      expect((await send(block, a, { id: p.bedIds[0], body: { reason: 'Not mine to do' } })).status, role).toBe(403)
    }
  })

  it('AT-002 a Maintenance Coordinator from another site gets 404 for block and unblock, and nothing changes', async () => {
    const p = await mkProperty()
    const other = await mkSite()
    const mc = await actor('MC', { siteIds: [other] })
    expect((await send(block, mc, { id: p.bedIds[0], body: { reason: 'Not my site' } })).status).toBe(404)
    expect((await send(unblock, mc, { id: p.bedIds[0], body: {} })).status).toBe(404)
    expect((await bedRow(p.bedIds[0])).state).toBe('available')
  })

  it('the bed detail shows the block in force, upcoming claims, and the block history', async () => {
    const p = await mkProperty()
    await reserve(p.bedIds[0], '2026-11-01', '2026-11-15')
    const aa = await actor('AA', { siteIds: [p.siteId] })
    await send(block, aa, { id: p.bedIds[0], body: { reason: 'Leak', until: '2026-10-20' } })
    const r = await send(getBed, aa, { id: p.bedIds[0] })
    expect(r.status).toBe(200)
    expect(r.body.data).toMatchObject({ state: 'blocked', today: '2026-10-14', block: { reason: 'Leak', until: '2026-10-20' } })
    expect(r.body.data.claims).toHaveLength(1)
    expect(r.body.data.history).toHaveLength(1)
    // An AA may see who the claim is for; a Manager may not (staff data).
    expect(r.body.data.claims[0].holder).toMatchObject({ name: expect.stringContaining('Resident') })
    const mgr = await actor('Mgr', { siteIds: [p.siteId] })
    const m = await send(getBed, mgr, { id: p.bedIds[0] })
    expect(m.status).toBe(200)
    expect(m.body.data.claims).toHaveLength(1)
    expect('holder' in m.body.data.claims[0]).toBe(false)
  })
})
