/**
 * Development / demo data: three sites and one user per role. NEVER for production (refuses to run there).
 * Idempotent: users and sites that already exist are left alone.
 *   DATABASE_URL=… [SEED_PASSWORD=…] npm run db:seed
 * Run with the migration (owner) role, not app_role.
 */
import { Pool } from 'pg'
import { hashPassword } from '../src/server/auth/password'

try { process.loadEnvFile('.env') } catch { /* real environment only */ }

if (process.env.NODE_ENV === 'production' && process.env.SEED_ALLOW_PRODUCTION !== 'yes-really') {
  console.error('Refusing to seed demo accounts in production')
  process.exit(1)
}
const url = process.env.DATABASE_URL
if (!url) { console.error('DATABASE_URL is not set'); process.exit(1) }
const password = process.env.SEED_PASSWORD ?? 'Welcome-GH-2026'

type Role = 'SA' | 'AA' | 'Rec' | 'Res' | 'MC' | 'Tech' | 'Vend' | 'Sec' | 'Mgr' | 'Aud'
const SITES = [
  { code: 'PV', name: 'Palm Villas', kind: 'villa' },
  { code: 'MA', name: 'Marina Apartments', kind: 'apartment' },
  { code: 'LV', name: 'Lakeview Residences', kind: 'apartment' },
] as const
const USERS: { employeeId: string; name: string; gender: 'male' | 'female'; roles: { role: Role; sites: 'all' | string[] | 'own' }[]; mustChange?: boolean }[] = [
  { employeeId: 'E9005', name: 'Vikram Shah', gender: 'male', roles: [{ role: 'SA', sites: 'all' }] },
  { employeeId: 'E9012', name: 'Meghna Rao', gender: 'female', roles: [{ role: 'SA', sites: 'all' }] },
  { employeeId: 'E9001', name: 'Anita Rao', gender: 'female', roles: [{ role: 'AA', sites: ['PV', 'MA'] }] },
  { employeeId: 'E9011', name: 'Kavita Nair', gender: 'female', roles: [{ role: 'AA', sites: ['LV'] }] },
  { employeeId: 'E9002', name: 'Rohan Das', gender: 'male', roles: [{ role: 'Rec', sites: ['PV', 'MA', 'LV'] }] },
  { employeeId: 'E9020', name: 'Farah Khan', gender: 'female', roles: [{ role: 'MC', sites: ['PV', 'MA', 'LV'] }] },
  { employeeId: 'E9030', name: 'Joseph Mathew', gender: 'male', roles: [{ role: 'Sec', sites: ['PV', 'MA', 'LV'] }] },
  { employeeId: 'E9040', name: 'Leena Verma', gender: 'female', roles: [{ role: 'Mgr', sites: ['PV', 'MA', 'LV'] }] },
  { employeeId: 'E9050', name: 'Arun Pillai', gender: 'male', roles: [{ role: 'Aud', sites: ['PV', 'MA', 'LV'] }] },
  { employeeId: 'E1007', name: 'Rahul Menon', gender: 'male', roles: [{ role: 'Res', sites: 'own' }] },
  { employeeId: 'E1099', name: 'Nisha Thomas (first sign-in)', gender: 'female', roles: [{ role: 'Res', sites: 'own' }], mustChange: true },
  { employeeId: 'E9060', name: 'Priya Iyer (AA and Resident)', gender: 'female', roles: [{ role: 'AA', sites: ['LV'] }, { role: 'Res', sites: 'own' }] },
]

const pool = new Pool({ connectionString: url })
try {
  const siteId = new Map<string, string>()
  for (const s of SITES) {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO site (code, name, kind) SELECT $1, $2, $3 WHERE NOT EXISTS (SELECT 1 FROM site WHERE code = $1) RETURNING id`, [s.code, s.name, s.kind])
    const id = r.rows[0]?.id ?? (await pool.query<{ id: string }>(`SELECT id FROM site WHERE code = $1`, [s.code])).rows[0].id
    siteId.set(s.code, id)
  }
  const hash = await hashPassword(password)
  let created = 0
  for (const u of USERS) {
    if ((await pool.query(`SELECT 1 FROM staff_profile WHERE lower(btrim(employee_id)) = lower($1)`, [u.employeeId])).rowCount) continue
    const staff = await pool.query<{ id: string }>(
      `INSERT INTO staff_profile (employee_id, full_name, gender, source) VALUES ($1, $2, $3, 'seed') RETURNING id`, [u.employeeId, u.name, u.gender])
    const acct = await pool.query<{ id: string }>(
      `INSERT INTO user_account (staff_id, username, password_hash, must_change_password, status) VALUES ($1, $2, $3, $4, 'active') RETURNING id`,
      [staff.rows[0].id, u.employeeId, hash, u.mustChange ?? false])
    for (const r of u.roles) {
      if (r.sites === 'all') await pool.query(`INSERT INTO role_assignment (user_id, role, scope_kind) VALUES ($1, $2, 'all')`, [acct.rows[0].id, r.role])
      else if (r.sites === 'own') await pool.query(`INSERT INTO role_assignment (user_id, role, scope_kind) VALUES ($1, $2, 'own')`, [acct.rows[0].id, r.role])
      else for (const code of r.sites) await pool.query(`INSERT INTO role_assignment (user_id, role, scope_kind, site_id) VALUES ($1, $2, 'site', $3)`, [acct.rows[0].id, r.role, siteId.get(code)])
    }
    created++
  }
  console.log(`seed: ${SITES.length} sites ensured, ${created} users created (username = employee ID, password from SEED_PASSWORD or the dev default)`)
} finally {
  await pool.end()
}
