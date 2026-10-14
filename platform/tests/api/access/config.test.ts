/**
 * Configuration: a typed registry, every change a NEW VERSION in the append-only config_item table.
 * Runs in a private database: it changes global settings (for example the lockout limit) that other test files rely on.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { acc, call, createIsolated, signIn, useClock } from './isolated'
import { POST as login } from '../../../app/api/v1/auth/login/route'
import { getDb } from '@/server/db/client'
import { CONFIG, getConfig } from '@/server/config/registry'
import { listConfig } from '@/server/queries/access/config'

const iso = await createIsolated()
let sa: ReturnType<typeof acc>
let appPool: Pool
beforeAll(async () => {
  useClock()
  sa = acc(await signIn(await iso.makeUser({ roles: [{ role: 'SA', all: true }] })))
  appPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 })
})
beforeEach(() => { useClock() })
afterAll(async () => { await appPool.end(); await iso.close() })

const put = (key: string, body: Record<string, unknown>) => sa.put('config/[key]', { params: { key }, body })
const versions = async (key: string, site?: string) =>
  (await iso.admin.query(`SELECT version, value, decision_ref, decision_status, reason, created_by, scope_site_id FROM config_item WHERE key = $1 AND ${site ? 'scope_site_id = $2' : 'scope_site_id IS NULL'} ORDER BY version`, site ? [key, site] : [key])).rows

describe('the configuration screen', () => {
  it('lists every registry key with its value, default, decision reference and status, open ones included', async () => {
    const r = await sa.get('config')
    expect(r.status).toBe(200)
    const rows = r.body.data as { key: string; value: unknown; default: unknown; ref: string; status: string; source: string; version: number | null; perSite: boolean }[]
    expect(rows.map(x => x.key).sort()).toEqual(Object.keys(CONFIG).sort())
    for (const row of rows) {
      const def = CONFIG[row.key as keyof typeof CONFIG]
      expect(row.default).toEqual(def.default)
      expect(row.ref).toBe(def.ref)
      expect(row.status).toBe(def.status)
      expect(row.perSite).toBe(!!(def as { perSite?: boolean }).perSite)
    }
    const open = rows.filter(x => x.status === 'open')
    expect(open.length).toBeGreaterThan(0)
    expect(open.map(x => x.key)).toEqual(expect.arrayContaining(['auth.password_min_length', 'calendar.weekend_days']))
    expect(rows.find(x => x.key === 'timers.offer_hours')).toMatchObject({ value: 48, source: 'default', version: null, status: 'decided', ref: 'D-49' })
  })

  it('only a Super Admin reads or changes it', async () => {
    const site = await iso.newSite()
    for (const role of ['AA', 'Rec', 'Aud', 'Mgr', 'Res'] as const) {
      const u = await iso.makeUser({ roles: [role === 'Res' ? { role } : { role, siteId: site }] })
      const c = acc(await signIn(u))
      expect((await c.get('config')).status, role).toBe(403)
      expect((await c.get('config/[key]', { params: { key: 'timers.offer_hours' } })).status, role).toBe(403)
      expect((await c.put('config/[key]', { params: { key: 'timers.offer_hours' }, body: { value: 50, reason: 'x' } })).status, role).toBe(403)
    }
    expect(await listConfig({ role: 'Aud', caps: [], sites: 'all' })).toEqual([]) // and the query itself says no
    expect((await versions('timers.offer_hours')).length).toBe(0)
  })
})

describe('versioning', () => {
  it('every save is a new version; the newest wins; old versions stay; the registry decision is recorded', async () => {
    const key = 'timers.offer_hours'
    expect(await getConfig(getDb(), key)).toBe(48)
    const v1 = await put(key, { value: 36, reason: 'Pilot: shorter offers' })
    expect(v1.status).toBe(200)
    expect(v1.body.data).toMatchObject({ key, version: 1, value: 36, siteId: null })
    expect(await getConfig(getDb(), key)).toBe(36)
    const v2 = await put(key, { value: 60, reason: 'Back to longer offers' })
    expect(v2.body.data.version).toBe(2)
    expect(await getConfig(getDb(), key)).toBe(60)

    const rows = await versions(key)
    expect(rows.map(r => [r.version, r.value])).toEqual([[1, 36], [2, 60]]) // the first version was not edited
    expect(rows[0]).toMatchObject({ decision_ref: 'D-49', decision_status: 'decided', reason: 'Pilot: shorter offers' })
    expect(rows[0].created_by).toBeTruthy()

    const h = await sa.get('config/[key]', { params: { key } })
    expect(h.status).toBe(200)
    expect(h.body.data.versions.map((v: { version: number }) => v.version)).toEqual([2, 1]) // newest first
    expect(h.body.data.versions[0]).toMatchObject({ value: 60, reason: 'Back to longer offers', decisionRef: 'D-49', valid: true })
    expect(h.body.data.row).toMatchObject({ key, ref: 'D-49', status: 'decided', default: 48 })

    const list = (await sa.get('config')).body.data.find((x: { key: string }) => x.key === key)
    expect(list).toMatchObject({ value: 60, source: 'saved', version: 2, reason: 'Back to longer offers' })
  })

  it('audits the value before and after, with the reason', async () => {
    const key = 'timers.no_show_hours'
    await put(key, { value: 30, reason: 'First' })
    await put(key, { value: 20, reason: 'Second' })
    const ev = (await iso.admin.query(`SELECT action, entity_type, reason, before, after FROM audit_event WHERE action = 'config.changed' AND after->>'key' = $1 ORDER BY seq`, [key])).rows
    expect(ev).toHaveLength(2)
    expect(ev[0]).toMatchObject({ entity_type: 'config', reason: 'First', before: { key, value: 24, version: null, decisionRef: 'D-58' }, after: { key, value: 30, version: 1, decisionStatus: 'default' } })
    expect(ev[1]).toMatchObject({ reason: 'Second', before: { value: 30, version: 1 }, after: { value: 20, version: 2 } })
  })

  it('refuses invalid values with a field message, a missing reason, an unknown key, and a missing value; nothing is saved', async () => {
    const key = 'auth.lockout_attempts'
    const tooLow = await put(key, { value: 1, reason: 'x' })
    expect(tooLow.status).toBe(422)
    expect(tooLow.body.fields.value).toBeTruthy()
    expect(tooLow.body.reason).toMatch(/Failed sign-ins before lockout/)
    expect((await put(key, { value: 'five', reason: 'x' })).status).toBe(422)
    expect((await put(key, { value: 5.5, reason: 'x' })).status).toBe(422)
    expect((await put(key, { value: 5 })).status).toBe(422) // reason required
    expect((await put(key, { value: 5, reason: '   ' })).status).toBe(422)
    expect((await put(key, { reason: 'x' })).status).toBe(422) // value required
    expect((await put('calendar.holidays', { value: ['14/10/2026'], reason: 'x' })).status).toBe(422)
    expect((await put('import.partial_policy', { value: 'maybe', reason: 'x' })).status).toBe(422)
    const unknown = await put('timers.made_up', { value: 1, reason: 'x' })
    expect(unknown.status).toBe(422)
    expect(unknown.body.fields.key).toBeTruthy()
    expect((await versions(key)).length).toBe(0)
    expect((await versions('calendar.holidays')).length).toBe(0)
  })

  it('a saved value that no longer fits the registry is ignored (the default applies) and the screen says so', async () => {
    const key = 'timers.sos_ack_minutes'
    await iso.admin.query(`INSERT INTO config_item (key, version, value) VALUES ($1, 1, '"soon"')`, [key])
    expect(await getConfig(getDb(), key)).toBe(5)
    const row = (await sa.get('config')).body.data.find((x: { key: string }) => x.key === key)
    expect(row).toMatchObject({ value: 5, source: 'default', storedInvalid: true, version: 1 })
    const h = await sa.get('config/[key]', { params: { key } })
    expect(h.body.data.versions[0]).toMatchObject({ version: 1, valid: false })
    const fixed = await put(key, { value: 7, reason: 'Replace the invalid value' })
    expect(fixed.body.data.version).toBe(2)
    expect(await getConfig(getDb(), key)).toBe(7)
  })

  it('two administrators saving the same setting at once get consecutive versions, and the highest wins', async () => {
    const key = 'timers.emergency_deadline_hours'
    const results = await Promise.all([10, 11, 12, 13, 14, 15].map(v => put(key, { value: v, reason: `v${v}` })))
    expect(results.map(r => r.status)).toEqual([200, 200, 200, 200, 200, 200])
    const got = results.map(r => r.body.data.version).sort()
    expect(got).toEqual([1, 2, 3, 4, 5, 6])
    const rows = await versions(key)
    expect(rows.map(r => r.version)).toEqual([1, 2, 3, 4, 5, 6])
    const newest = rows[5]
    expect(await getConfig(getDb(), key)).toBe(newest.value)
  })
})

describe('per-site values', () => {
  it('only for settings the registry marks per-site; the site value wins at that site, the global value elsewhere', async () => {
    const siteA = await iso.newSite(), siteB = await iso.newSite()
    const key = 'calendar.weekend_days'
    expect(CONFIG[key].perSite).toBe(true)
    expect(await getConfig(getDb(), key, siteA)).toEqual([0, 6])
    const g = await put(key, { value: [5, 6], reason: 'Group default: Friday and Saturday' })
    expect(g.body.data.version).toBe(1)
    const a = await put(key, { value: [5], siteId: siteA, reason: 'Villas work Saturdays' })
    expect(a.status).toBe(200)
    expect(a.body.data).toMatchObject({ version: 1, siteId: siteA }) // its own version line
    expect(await getConfig(getDb(), key, siteA)).toEqual([5])
    expect(await getConfig(getDb(), key, siteB)).toEqual([5, 6]) // falls back to the global value
    expect(await getConfig(getDb(), key)).toEqual([5, 6])
    const a2 = await put(key, { value: [4, 5], siteId: siteA, reason: 'Changed again' })
    expect(a2.body.data.version).toBe(2)
    expect((await versions(key, siteA)).map(r => r.version)).toEqual([1, 2])
    expect((await versions(key)).map(r => r.version)).toEqual([1])

    const row = (await sa.get('config')).body.data.find((x: { key: string }) => x.key === key)
    expect(row.value).toEqual([5, 6])
    expect(row.overrides).toEqual([expect.objectContaining({ siteId: siteA, value: [4, 5], version: 2 })])
    const h = await sa.get('config/[key]', { params: { key }, query: { siteId: siteA } })
    expect(h.body.data.versions.map((v: { version: number; siteId: string }) => [v.version, v.siteId])).toEqual([[2, siteA], [1, siteA]])

    const ev = (await iso.admin.query(`SELECT site_id FROM audit_event WHERE action = 'config.changed' AND after->>'key' = $1 ORDER BY seq`, [key])).rows
    expect(ev.map(e => e.site_id)).toEqual([null, siteA, siteA]) // site values are audited against their site
  })

  it('refuses a site for a global-only setting, and a site that does not exist', async () => {
    const site = await iso.newSite()
    const r = await put('timers.offer_hours', { value: 40, siteId: site, reason: 'x' })
    expect(r.status).toBe(422)
    expect(r.body.fields.siteId).toBeTruthy()
    expect((await put('calendar.holidays', { value: [], siteId: crypto.randomUUID(), reason: 'x' })).status).toBe(422)
    expect((await versions('timers.offer_hours', site)).length).toBe(0)
  })
})

describe('append-only, for every role', () => {
  it('the application role is refused UPDATE, DELETE and TRUNCATE on config_item, and so is the owner (GH002)', async () => {
    await put('timers.waitlist_entry_days', { value: 20, reason: 'seed a row' })
    const q = (p: Pool | typeof iso.admin, sql: string) => p.query(sql).then(() => null, (e: { code?: string }) => e.code)
    expect(await q(appPool, `UPDATE config_item SET value = '1' WHERE key = 'timers.waitlist_entry_days'`)).toBe('42501')
    expect(await q(appPool, `DELETE FROM config_item WHERE key = 'timers.waitlist_entry_days'`)).toBe('42501')
    expect(await q(appPool, `TRUNCATE config_item`)).toBe('42501')
    expect(await q(iso.admin, `UPDATE config_item SET value = '1' WHERE key = 'timers.waitlist_entry_days'`)).toBe('GH002')
    expect(await q(iso.admin, `DELETE FROM config_item WHERE key = 'timers.waitlist_entry_days'`)).toBe('GH002')
    expect((await versions('timers.waitlist_entry_days')).map(r => r.value)).toEqual([20])
  })
})

describe('what is saved is what the application uses', () => {
  it('lowering the lockout limit changes the real sign-in behaviour at once', async () => {
    const u = await iso.makeUser({ roles: [{ role: 'Rec', siteId: await iso.newSite() }] })
    expect((await put('auth.lockout_attempts', { value: 3, reason: 'Stricter while GH-14 is open' })).status).toBe(200)
    for (let i = 0; i < 3; i++) expect((await call(login, { body: { username: u.username, password: 'wrong-wrong-1' } })).status).toBe(401)
    expect((await call(login, { body: { username: u.username, password: u.password } })).status).toBe(429) // locked after 3, not 5
  })
})
