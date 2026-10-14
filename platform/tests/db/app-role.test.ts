import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Client, Pool } from 'pg'
import { appDbUrl, newBed, newClient, newPool, newStaff, one, pgError, uniq } from './helpers'

const INSUFFICIENT_PRIVILEGE = '42501'
const APPEND_ONLY = 'GH002'

let admin: Pool
let app: Client
beforeAll(async () => {
  admin = newPool()
  app = await newClient(appDbUrl())
})
afterAll(async () => {
  await app.end()
  await admin.end()
})

describe('connected AS the application role', () => {
  it('is a plain, non-superuser login that only inherits app_role', async () => {
    const me = await one<{ current_user: string; is_super: boolean; member: boolean }>(app, `
      SELECT current_user,
             (SELECT rolsuper OR rolcreaterole OR rolcreatedb OR rolbypassrls FROM pg_roles WHERE rolname = current_user) AS is_super,
             pg_has_role(current_user, 'app_role', 'USAGE') AS member`)
    expect(me.is_super).toBe(false)
    expect(me.member).toBe(true)
    expect(me.current_user).toMatch(/^gh_app_login_/)
    const role = await one<{ rolsuper: boolean; rolcanlogin: boolean }>(admin, `SELECT rolsuper, rolcanlogin FROM pg_roles WHERE rolname = 'app_role'`)
    expect(role).toEqual({ rolsuper: false, rolcanlogin: false })
  })
})

describe('audit_event is append-only', () => {
  let auditId: string
  it('INSERT and SELECT work', async () => {
    const row = await one<{ id: string; seq: string }>(app, `INSERT INTO audit_event (action, entity_type) VALUES ('test.append', 'bed') RETURNING id, seq`)
    auditId = row.id
    const read = await one<{ action: string }>(app, `SELECT action FROM audit_event WHERE id = $1`, [auditId])
    expect(read.action).toBe('test.append')
  })

  it('sequence numbers only go up', async () => {
    const a = await one<{ seq: string }>(app, `INSERT INTO audit_event (action) VALUES ('test.seq1') RETURNING seq`)
    const b = await one<{ seq: string }>(app, `INSERT INTO audit_event (action) VALUES ('test.seq2') RETURNING seq`)
    expect(BigInt(b.seq)).toBeGreaterThan(BigInt(a.seq))
  })

  it('UPDATE is refused', async () => {
    expect((await pgError(app.query(`UPDATE audit_event SET action = 'tampered' WHERE id = $1`, [auditId]))).code).toBe(INSUFFICIENT_PRIVILEGE)
  })
  it('DELETE is refused', async () => {
    expect((await pgError(app.query(`DELETE FROM audit_event WHERE id = $1`, [auditId]))).code).toBe(INSUFFICIENT_PRIVILEGE)
  })
  it('TRUNCATE is refused', async () => {
    expect((await pgError(app.query(`TRUNCATE audit_event`))).code).toBe(INSUFFICIENT_PRIVILEGE)
  })

  it('the row is unchanged after all of that', async () => {
    expect((await one<{ action: string }>(app, `SELECT action FROM audit_event WHERE id = $1`, [auditId])).action).toBe('test.append')
  })

  it('even the owning superuser cannot rewrite history: triggers refuse UPDATE, DELETE and TRUNCATE', async () => {
    expect((await pgError(admin.query(`UPDATE audit_event SET action = 'tampered' WHERE id = $1`, [auditId]))).code).toBe(APPEND_ONLY)
    expect((await pgError(admin.query(`DELETE FROM audit_event WHERE id = $1`, [auditId]))).code).toBe(APPEND_ONLY)
    expect((await pgError(admin.query(`TRUNCATE audit_event`))).code).toBe(APPEND_ONLY)
  })
})

describe('config_item is versioned and append-only', () => {
  it('a change is a new version; the old version cannot be edited or removed', async () => {
    const key = uniq('cfg.offer_hours')
    await app.query(`INSERT INTO config_item (key, version, value, decision_ref, decision_status) VALUES ($1, 1, '48', 'D-49', 'default')`, [key])
    await app.query(`INSERT INTO config_item (key, version, value) VALUES ($1, 2, '72')`, [key])
    expect((await pgError(app.query(`INSERT INTO config_item (key, version, value) VALUES ($1, 2, '96')`, [key]))).code).toBe('23505')
    expect((await pgError(app.query(`UPDATE config_item SET value = '1' WHERE key = $1`, [key]))).code).toBe(INSUFFICIENT_PRIVILEGE)
    expect((await pgError(app.query(`DELETE FROM config_item WHERE key = $1`, [key]))).code).toBe(INSUFFICIENT_PRIVILEGE)
    expect((await pgError(admin.query(`UPDATE config_item SET value = '1' WHERE key = $1`, [key]))).code).toBe(APPEND_ONLY)
    const current = await one<{ version: number }>(app, `SELECT max(version) AS version FROM config_item WHERE key = $1`, [key])
    expect(current.version).toBe(2)
  })
})

describe('no deletion: app_role can read, create and update business rows, never delete them', () => {
  it('works for a representative row through its whole create/update/archive life', async () => {
    const code = uniq('APP')
    const site = await one<{ id: string }>(app, `INSERT INTO site (code, name) VALUES ($1, 'Via app role') RETURNING id`, [code])
    await app.query(`UPDATE site SET archived_at = now() WHERE id = $1`, [site.id])
    expect((await one<{ archived_at: Date | null }>(app, `SELECT archived_at FROM site WHERE id = $1`, [site.id])).archived_at).not.toBeNull()
    expect((await pgError(app.query(`DELETE FROM site WHERE id = $1`, [site.id]))).code).toBe(INSUFFICIENT_PRIVILEGE)
    expect((await pgError(app.query(`TRUNCATE site CASCADE`))).code).toBe(INSUFFICIENT_PRIVILEGE)
  })

  it('cannot delete a bed, a claim, a stay or a staff profile', async () => {
    const { bedId } = await newBed(admin)
    const staffId = await newStaff(admin)
    for (const [table, id] of [['bed', bedId], ['staff_profile', staffId]] as const) {
      expect((await pgError(app.query(`DELETE FROM ${table} WHERE id = $1`, [id]))).code, table).toBe(INSUFFICIENT_PRIVILEGE)
    }
    expect((await pgError(app.query(`DELETE FROM bed_claim`))).code).toBe(INSUFFICIENT_PRIVILEGE)
    expect((await pgError(app.query(`DELETE FROM stay`))).code).toBe(INSUFFICIENT_PRIVILEGE)
  })

  it('cannot change the transition rules or the migration history', async () => {
    expect((await pgError(app.query(`INSERT INTO state_transition (entity, from_state, to_state) VALUES ('bed.state', 'occupied', 'available')`))).code).toBe(INSUFFICIENT_PRIVILEGE)
    expect((await pgError(app.query(`DELETE FROM state_transition`))).code).toBe(INSUFFICIENT_PRIVILEGE)
    expect((await pgError(app.query(`SELECT * FROM schema_migrations`))).code).toBe(INSUFFICIENT_PRIVILEGE)
  })

  it('catalogue check: on EVERY table in the schema app_role holds no DELETE or TRUNCATE, and nothing beyond INSERT/SELECT on append-only tables', async () => {
    const tables = (await admin.query<{ tablename: string }>(`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`)).rows.map(r => r.tablename)
    expect(tables.length).toBeGreaterThanOrEqual(18)
    const appendOnly = new Set(['audit_event', 'config_item'])
    for (const t of tables) {
      const p = await one<{ del: boolean; trunc: boolean; upd: boolean }>(admin,
        `SELECT has_table_privilege('app_role', $1, 'DELETE') AS del,
                has_table_privilege('app_role', $1, 'TRUNCATE') AS trunc,
                has_table_privilege('app_role', $1, 'UPDATE') AS upd`, [`public.${t}`])
      expect(p.del, `${t} DELETE`).toBe(false)
      expect(p.trunc, `${t} TRUNCATE`).toBe(false)
      if (appendOnly.has(t)) expect(p.upd, `${t} UPDATE`).toBe(false)
    }
  })
})
