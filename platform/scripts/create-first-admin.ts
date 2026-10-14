/**
 * Creates the first Super Admin on a new installation (the demo seed refuses to run in production).
 * Run once, with the migration (owner) role. Refuses if any Super Admin already exists.
 *   DATABASE_URL=… ADMIN_EMPLOYEE_ID=E0001 ADMIN_NAME="Full Name" ADMIN_PASSWORD='a-long-temporary-password' npm run db:first-admin
 * The password is temporary: the account must set a new one at first sign-in. Recorded in the audit log.
 */
import { Pool } from 'pg'
import { hashPassword, passwordProblem } from '../src/server/auth/password'

try { process.loadEnvFile('.env') } catch { /* real environment only */ }

const url = process.env.DATABASE_URL
const employeeId = process.env.ADMIN_EMPLOYEE_ID?.trim()
const name = process.env.ADMIN_NAME?.trim()
const password = process.env.ADMIN_PASSWORD
if (!url || !employeeId || !name || !password) {
  console.error('Set DATABASE_URL, ADMIN_EMPLOYEE_ID, ADMIN_NAME and ADMIN_PASSWORD'); process.exit(1)
}
const problem = passwordProblem(password, { username: employeeId, minLength: 12 })
if (problem) { console.error(`ADMIN_PASSWORD: ${problem}`); process.exit(1) }

const pool = new Pool({ connectionString: url })
const client = await pool.connect()
try {
  await client.query('BEGIN')
  if ((await client.query(`SELECT 1 FROM role_assignment WHERE role = 'SA' LIMIT 1`)).rowCount) {
    console.error('A Super Admin already exists. Nothing changed.'); await client.query('ROLLBACK'); process.exit(1)
  }
  if ((await client.query(`SELECT 1 FROM staff_profile WHERE lower(btrim(employee_id)) = lower($1)`, [employeeId])).rowCount) {
    console.error(`Employee ID ${employeeId} already exists. Nothing changed.`); await client.query('ROLLBACK'); process.exit(1)
  }
  // gender is optional on the staff record and is not asked here; add it in Staff afterwards
  const staff = await client.query<{ id: string }>(
    `INSERT INTO staff_profile (employee_id, full_name, source) VALUES ($1, $2, 'manual') RETURNING id`, [employeeId, name])
  const acct = await client.query<{ id: string }>(
    `INSERT INTO user_account (staff_id, username, password_hash, must_change_password, status) VALUES ($1, $2, $3, true, 'active') RETURNING id`,
    [staff.rows[0].id, employeeId, await hashPassword(password)])
  await client.query(`INSERT INTO role_assignment (user_id, role, scope_kind) VALUES ($1, 'SA', 'all')`, [acct.rows[0].id])
  await client.query(
    `INSERT INTO audit_event (actor_user_id, actor_role, action, entity_type, entity_id, reason) VALUES (NULL, NULL, 'bootstrap.first_admin', 'user_account', $1, 'First Super Admin created from the command line')`,
    [acct.rows[0].id])
  await client.query('COMMIT')
  console.log(`First Super Admin created: username ${employeeId}. They must set a new password at first sign-in.`)
} catch (e) {
  await client.query('ROLLBACK').catch(() => {}); throw e
} finally {
  client.release(); await pool.end()
}
