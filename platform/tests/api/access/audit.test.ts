/// <reference types="vite/client" />
import { acc, admin, call, closeAll, dump, makeUser, newSite, newStaff, signIn, signedIn, superAdmin, uniq } from './helpers'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { inject } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { Client } from 'pg'
import { POST as login } from '../../../app/api/v1/auth/login/route'
import { POST as changePassword } from '../../../app/api/v1/auth/change-password/route'
import { redact } from '@/server/queries/access/audit'

afterAll(closeAll)

type Ev = { seq: number; action: string; siteId: string | null; actorUsername: string | null; entityId: string | null; before: unknown; after: unknown }
const events = async (api: ReturnType<typeof acc>, query: Record<string, string>) => {
  const r = await api.get('audit', { query })
  expect(r.status, JSON.stringify(r.body)).toBe(200)
  return r.body.data as { rows: Ev[]; nextBefore: number | null }
}

/* ------------------------------------------------------------------ AT-028 */

const routeModules = import.meta.glob('../../../app/api/**/route.ts', { eager: true }) as Record<string, Record<string, unknown>>
const MUTATING = ['POST', 'PUT', 'PATCH', 'DELETE']

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (name === 'node_modules' || name === '.next') continue
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(name)) out.push(p)
  }
  return out
}

describe('AT-028 audit immutability', () => {
  it('AT-028 no API route can change or delete an audit row: no mutating method sits on an audit path', () => {
    const files = Object.keys(routeModules)
    expect(files.length).toBeGreaterThan(5)
    const onAuditPaths = files.filter(f => /\/audit(\/|$|-)/i.test(f.replace('../../../app/api', '')) || /audit/i.test(path.basename(path.dirname(f))))
    expect(onAuditPaths.length).toBeGreaterThan(0) // the viewer exists, so the scan is looking at something
    for (const f of onAuditPaths) {
      const mutating = MUTATING.filter(m => m in routeModules[f])
      expect(mutating, `${f} exports ${mutating.join(', ')}`).toEqual([])
    }
    // whatever the path is called, a route may not claim to change audit data
    for (const f of files) for (const m of MUTATING) if (m in routeModules[f]) {
      const name = (routeModules[f][m] as { meta?: { name: string } }).meta?.name ?? ''
      expect(name, `${m} ${f}`).not.toMatch(/audit/i)
    }
  })

  it('AT-028 no application code updates, deletes or truncates audit_event', () => {
    const root = path.resolve(process.cwd())
    const sources = [...walk(path.join(root, 'src')), ...walk(path.join(root, 'app'))]
    expect(sources.length).toBeGreaterThan(20)
    const banned = [/\.update\(\s*auditEvent/, /\.delete\(\s*auditEvent/, /update\s+["']?audit_event/i, /delete\s+from\s+["']?audit_event/i, /truncate\s+(table\s+)?["']?audit_event/i, /drop\s+table\s+["']?audit_event/i]
    for (const f of sources) {
      const text = readFileSync(f, 'utf8')
      for (const re of banned) expect(re.test(text), `${path.relative(root, f)} matches ${re}`).toBe(false)
    }
  })

  it('AT-028 the audit URL answers nothing but GET', async () => {
    const mod = routeModules['../../../app/api/v1/access/audit/route.ts']
    expect(Object.keys(mod).filter(k => ['GET', 'HEAD', 'OPTIONS', ...MUTATING].includes(k))).toEqual(['GET'])
  })

  it('AT-028 the application database role is refused UPDATE, DELETE and TRUNCATE on the audit log, and the row is unchanged', async () => {
    const sa = await superAdmin()
    await sa.api.get('users')
    const row = (await admin().query<{ id: string; action: string }>(`SELECT id, action FROM audit_event WHERE actor_user_id = $1 LIMIT 1`, [sa.user.id])).rows[0]
    expect(row).toBeDefined()
    const app = new Client({ connectionString: inject('appDbUrl') })
    await app.connect()
    try {
      const code = (sql: string, v: unknown[] = []) => app.query(sql, v).then(() => 'succeeded', (e: { code?: string }) => e.code)
      expect(await code(`UPDATE audit_event SET action = 'tampered' WHERE id = $1`, [row.id])).toBe('42501')
      expect(await code(`UPDATE audit_event SET reason = 'tampered'`)).toBe('42501')
      expect(await code(`DELETE FROM audit_event WHERE id = $1`, [row.id])).toBe('42501')
      expect(await code(`TRUNCATE audit_event`)).toBe('42501')
      expect(await code(`INSERT INTO audit_event (action) VALUES ('test.append_still_works')`)).toBe('succeeded')
    } finally { await app.end() }
    expect((await admin().query(`SELECT action FROM audit_event WHERE id = $1`, [row.id])).rows[0].action).toBe(row.action)
  })

  it('AT-028 even the owner is refused: the append-only trigger raises GH002', async () => {
    const owner = new Client({ connectionString: inject('dbUrl') })
    await owner.connect()
    try {
      const row = (await owner.query<{ id: string }>(`SELECT id FROM audit_event LIMIT 1`)).rows[0]
      const code = (sql: string, v: unknown[] = []) => owner.query(sql, v).then(() => 'succeeded', (e: { code?: string }) => e.code)
      expect(await code(`UPDATE audit_event SET action = 'tampered' WHERE id = $1`, [row.id])).toBe('GH002')
      expect(await code(`DELETE FROM audit_event WHERE id = $1`, [row.id])).toBe('GH002')
      expect(await code(`TRUNCATE audit_event`)).toBe('GH002')
    } finally { await owner.end() }
  })
})

/* ------------------------------------------------------------------ scope */

describe('who sees which audit events', () => {
  let siteA: string, siteB: string
  let sa: Awaited<ReturnType<typeof superAdmin>>
  let eventsA: string[], eventsB: string[]
  beforeAll(async () => {
    siteA = await newSite(); siteB = await newSite()
    sa = await superAdmin()
    const a = await newStaff(), b = await newStaff()
    eventsA = [(await sa.api.post('users', { body: { employeeId: a.employeeId, siteId: siteA } })).body.data.userId]
    eventsB = [(await sa.api.post('users', { body: { employeeId: b.employeeId, siteId: siteB } })).body.data.userId]
  })

  it('a Super Admin sees everything, including events that belong to no site (sign-ins)', async () => {
    const page = await events(sa.api, { actor: sa.user.username })
    const actions = page.rows.map(r => r.action)
    expect(actions).toContain('auth.login')
    expect(page.rows.filter(r => r.action === 'access.account.created').map(r => r.entityId).sort()).toEqual([...eventsA, ...eventsB].sort())
  })

  it('an Auditor limited to a site sees that site\'s events only: not other sites, not site-less events', async () => {
    const aud = await signedIn({ roles: [{ role: 'Aud', siteId: siteA }] })
    const page = await events(aud.api, { actor: sa.user.username })
    expect(page.rows.map(r => r.entityId)).toEqual(eventsA)
    expect(page.rows.every(r => r.siteId === siteA)).toBe(true)
    expect(page.rows.map(r => r.action)).not.toContain('auth.login')
    const probe = await events(aud.api, { entityId: eventsB[0] })
    expect(probe.rows).toEqual([]) // out of scope reads like nothing there
    const both = await signedIn({ roles: [{ role: 'Aud', siteId: siteA }, { role: 'Aud', siteId: siteB }] })
    expect((await events(both.api, { actor: sa.user.username })).rows.map(r => r.entityId).sort()).toEqual([...eventsA, ...eventsB].sort())
  })

  it('an Auditor with a global assignment sees all of it', async () => {
    const aud = await signedIn({ roles: [{ role: 'Aud', all: true }] })
    const page = await events(aud.api, { actor: sa.user.username })
    expect(page.rows.map(r => r.action)).toContain('auth.login')
    expect(page.rows.filter(r => r.action === 'access.account.created')).toHaveLength(2)
  })

  it('everyone else is refused: an Accommodation Admin even on their own site (no grant defined), Reception, Resident, Manager', async () => {
    for (const role of ['AA', 'Rec', 'Res', 'Mgr', 'MC', 'Sec'] as const) {
      const u = await signedIn({ roles: [role === 'Res' ? { role } : { role, siteId: siteA }] })
      expect((await u.api.get('audit')).status, role).toBe(403)
    }
  })

  it('answers 401 without a session', async () => {
    expect((await acc().get('audit')).status).toBe(401)
  })
})

/* ------------------------------------------------------------------ filters, pagination */

describe('filters and keyset pagination', () => {
  it('filters by action prefix, entity, actor (name or id) and date range', async () => {
    const sa = await superAdmin()
    const site = await newSite()
    const s = await newStaff()
    const made = (await sa.api.post('users', { body: { employeeId: s.employeeId, siteId: site } })).body.data
    await sa.api.post('users/[id]/reset-password', { params: { id: made.userId } })
    await sa.api.post('users/[id]/deactivate', { params: { id: made.userId }, body: { reason: 'audit filter test' } })

    const byEntity = await events(sa.api, { entityType: 'user_account', entityId: made.userId })
    expect(byEntity.rows.map(r => r.action)).toEqual(['access.account.deactivated', 'access.account.password_reset', 'access.account.created']) // newest first
    expect((await events(sa.api, { entityId: made.userId, action: 'access.account.pass' })).rows.map(r => r.action)).toEqual(['access.account.password_reset']) // prefix
    expect((await events(sa.api, { entityId: made.userId, action: 'ACCESS.' })).rows).toHaveLength(3) // case-insensitive
    expect((await events(sa.api, { entityId: made.userId, action: 'auth.' })).rows).toEqual([])
    expect((await events(sa.api, { entityId: made.userId, entityType: 'bed' })).rows).toEqual([])
    expect((await events(sa.api, { entityId: 'not-a-uuid' })).rows).toEqual([])
    expect((await events(sa.api, { action: '%' })).rows).toEqual([]) // a wildcard is a literal, not "everything"

    const mine = await events(sa.api, { actor: sa.user.username.toUpperCase(), entityId: made.userId })
    expect(mine.rows).toHaveLength(3)
    expect((await events(sa.api, { actor: sa.user.id, entityId: made.userId })).rows).toHaveLength(3)
    expect((await events(sa.api, { actor: uniq('nobody'), entityId: made.userId })).rows).toEqual([])

    const today = new Date().toISOString().slice(0, 10)
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)
    expect((await events(sa.api, { entityId: made.userId, from: today, to: today })).rows).toHaveLength(3) // a bare day is inclusive
    expect((await events(sa.api, { entityId: made.userId, to: yesterday })).rows).toEqual([])
    expect((await events(sa.api, { entityId: made.userId, from: tomorrow })).rows).toEqual([])
    expect((await events(sa.api, { entityId: made.userId, from: new Date(Date.now() - 3_600_000).toISOString() })).rows).toHaveLength(3)

    const bad = await sa.api.get('audit', { query: { from: 'yesterday-ish' } })
    expect(bad.status).toBe(422)
    expect(bad.body.fields.from).toBeTruthy()
    expect((await sa.api.get('audit', { query: { limit: '5000' } })).status).toBe(422)
  })

  it('pages newest first on seq with no gaps and no overlap, however many events arrive meanwhile', async () => {
    const sa = await superAdmin()
    const u = await makeUser({ roles: [{ role: 'Res' }] })
    for (let i = 0; i < 7; i++) await signIn(u) // each sign-in is one auth.login event by this user
    const all = (await admin().query<{ seq: string }>(`SELECT seq FROM audit_event WHERE actor_user_id = $1 ORDER BY seq DESC`, [u.id])).rows.map(r => Number(r.seq))
    expect(all).toHaveLength(7)

    const seen: number[] = []
    let before: string | undefined
    const sizes: number[] = []
    for (let page = 0; page < 5; page++) {
      const r = await events(sa.api, { actor: u.username, limit: '3', ...(before ? { before } : {}) })
      sizes.push(r.rows.length)
      seen.push(...r.rows.map(x => x.seq))
      if (page === 0) await signIn(u) // new events arriving between pages do not disturb the cursor
      if (r.nextBefore === null) break
      expect(r.nextBefore).toBe(r.rows[r.rows.length - 1].seq)
      before = String(r.nextBefore)
    }
    expect(sizes).toEqual([3, 3, 1])
    expect(seen).toEqual(all)
    expect(new Set(seen).size).toBe(7)
    expect(seen).toEqual([...seen].sort((a, b) => b - a))
  })
})

/* ------------------------------------------------------------------ no secrets */

const SECRETISH = /(pass(word|wd)?|secret|token|hash|credential|authorization|cookie)/i
function secretKeys(v: unknown, trail = ''): string[] {
  if (Array.isArray(v)) return v.flatMap((x, i) => secretKeys(x, `${trail}[${i}]`))
  if (v && typeof v === 'object') return Object.entries(v).flatMap(([k, x]) => (SECRETISH.test(k) && typeof x === 'string' ? [`${trail}.${k}`] : []).concat(secretKeys(x, `${trail}.${k}`)))
  return []
}

describe('secrets never reach the audit log', () => {
  it('after creating, resetting, reactivating, signing in and changing a password, no audit row holds a password, hash or token, in any key', async () => {
    const sa = await superAdmin()
    const s = await newStaff()
    const made = (await sa.api.post('users', { body: { employeeId: s.employeeId } })).body.data
    const first = await call(login, { body: { username: made.username, password: made.temporaryPassword } })
    const cookie = first.cookies[0].split(';')[0]
    const token = cookie.split('=')[1]
    await call(login, { body: { username: made.username, password: 'wrong-wrong-1' } })
    await call(changePassword, { cookie, body: { current: made.temporaryPassword, next: 'Brand-new-pass-77' } })
    const reset = (await sa.api.post('users/[id]/reset-password', { params: { id: made.userId } })).body.data
    await sa.api.post('users/[id]/deactivate', { params: { id: made.userId }, body: { reason: 'secrets test' } })
    const re = (await sa.api.post('users/[id]/reactivate', { params: { id: made.userId }, body: { reason: 'secrets test' } })).body.data

    const text = await dump(['audit_event', 'role_change_request', 'capability_grant', 'config_item'])
    for (const secret of [made.temporaryPassword, reset.temporaryPassword, re.temporaryPassword, 'Brand-new-pass-77', 'wrong-wrong-1', token]) {
      expect(text.includes(secret), `a secret appears in the stored rows`).toBe(false)
    }
    expect(text).not.toMatch(/\$argon2/)
    const rows = (await admin().query<{ id: string; before: unknown; after: unknown }>(`SELECT id, before, after FROM audit_event`)).rows
    expect(rows.length).toBeGreaterThan(10)
    const offenders = rows.flatMap(r => [...secretKeys(r.before), ...secretKeys(r.after)].map(k => `${r.id}${k}`))
    expect(offenders).toEqual([])

    // and the viewer never returns one either
    const viewer = JSON.stringify((await sa.api.get('audit', { query: { actor: sa.user.username, limit: '200' } })).body)
    for (const secret of [made.temporaryPassword, reset.temporaryPassword, re.temporaryPassword]) expect(viewer).not.toContain(secret)
  })

  it('the viewer masks a secret-looking value even if one were ever stored, but leaves flags and numbers alone', () => {
    expect(redact({ password: 'hunter2', nested: { sessionToken: 'abc', list: [{ passwordHash: 'x' }] }, mustChangePassword: true, tokens: 3, ok: 'fine' }))
      .toEqual({ password: '[redacted]', nested: { sessionToken: '[redacted]', list: [{ passwordHash: '[redacted]' }] }, mustChangePassword: true, tokens: 3, ok: 'fine' })
  })
})
