import { readFileSync, readdirSync, readlinkSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { Client } from 'pg'
import { expect, test, type Page } from '@playwright/test'

/**
 * WP-L smoke (run with E2E_PORT=3140). Two PROPOSED policies, both pending client sign-off, seen through the screens:
 *  P-01  a Policy Approver decides an escalated request from the approvals inbox; with the setting switched off the inbox says why and the API refuses;
 *  P-02  the password field (D-03) appears on the emergency check-in form, the role-request form and the waitlist queue-override form, a wrong password changes
 *        nothing and shows the field error, the right one goes through.
 * It creates its own people, beds, requests and waitlist entries; the only shared thing it touches is the escalation setting, which it puts back.
 */
const PASSWORD = 'Welcome-GH-2026'
const PORT = Number(process.env.E2E_PORT ?? 3120)
const tag = randomBytes(3).toString('hex').toUpperCase()

async function signIn(page: Page, username: string) {
  await page.context().clearCookies()
  await page.goto('/login')
  await page.getByLabel('Username').fill(username)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL(u => !u.pathname.startsWith('/login'))
}

/** The database of the server that global setup started on our port (Linux). E2E_DATABASE_URL overrides. */
function serverDatabaseUrl(): string {
  if (process.env.E2E_DATABASE_URL) return process.env.E2E_DATABASE_URL
  const hex = PORT.toString(16).toUpperCase().padStart(4, '0')
  const inodes = new Set<string>()
  for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text = ''
    try { text = readFileSync(f, 'utf8') } catch { continue }
    for (const line of text.split('\n').slice(1)) {
      const c = line.trim().split(/\s+/)
      if (c.length > 9 && c[3] === '0A' && c[1].endsWith(`:${hex}`)) inodes.add(c[9])
    }
  }
  for (const pid of readdirSync('/proc').filter(n => /^\d+$/.test(n))) {
    try {
        for (const fd of readdirSync(`/proc/${pid}/fd`)) {
          const m = /^socket:\[(\d+)\]$/.exec(readlinkSync(`/proc/${pid}/fd/${fd}`))
          if (!m || !inodes.has(m[1])) continue
          const entry = readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').find(e => e.startsWith('DATABASE_URL='))
          if (entry) return entry.slice('DATABASE_URL='.length)
        }
      } catch { /* not ours to read */ }
    }
    throw new Error(`Could not find the database of the server on port ${PORT}; set E2E_DATABASE_URL`)
  }

  async function withDb<T>(fn: (db: Client) => Promise<T>): Promise<T> {
    const db = new Client({ connectionString: serverDatabaseUrl() })
    await db.connect()
    try { return await fn(db) } finally { await db.end() }
  }

  /** A person with a login (the seed password), a role at Palm Villas and, optionally, capabilities. */
  async function person(db: Client, key: string, o: { role: string; caps?: string[]; site?: string }) {
    const emp = `L-${tag}-${key}`
    const site = (await db.query<{ id: string }>(`SELECT id FROM site WHERE code = $1`, [o.site ?? 'PV'])).rows[0].id
    const hash = (await db.query<{ password_hash: string }>(`SELECT password_hash FROM user_account WHERE username = 'E9002'`)).rows[0].password_hash
    const staff = (await db.query<{ id: string }>(`INSERT INTO staff_profile (employee_id, full_name, source) VALUES ($1, $2, 'manual') RETURNING id`, [emp, `Person ${key} ${tag}`])).rows[0].id
    const user = (await db.query<{ id: string }>(`INSERT INTO user_account (staff_id, username, password_hash, must_change_password, status) VALUES ($1, $2, $3, false, 'active') RETURNING id`, [staff, emp, hash])).rows[0].id
    await db.query(`INSERT INTO role_assignment (user_id, role, scope_kind, site_id) VALUES ($1, $2, $3, $4)`, [user, o.role, o.role === 'Res' ? 'own' : 'site', o.role === 'Res' ? null : site])
    if (o.caps?.length) {
      const maker = (await db.query<{ id: string }>(`SELECT u.id FROM user_account u JOIN staff_profile s ON s.id = u.staff_id WHERE s.employee_id = 'E9005'`)).rows[0].id
      const checker = (await db.query<{ id: string }>(`SELECT u.id FROM user_account u JOIN staff_profile s ON s.id = u.staff_id WHERE s.employee_id = 'E9012'`)).rows[0].id
      for (const cap of o.caps) {
        await db.query(`INSERT INTO capability_grant (user_id, capability, reason, starts_at, status, maker_id, checker_id, decided_at) VALUES ($1, $2, 'e2e', now() - interval '1 day', 'active', $3, $4, now())`, [user, cap, maker, checker])
      }
    }
    return { emp, staff, user, name: `Person ${key} ${tag}`, site }
  }
  async function room(db: Client, siteId: string, name: string, beds: number) {
    const roomId = (await db.query<{ id: string }>(`INSERT INTO room (site_id, name) VALUES ($1, $2) RETURNING id`, [siteId, name])).rows[0].id
    const codes: string[] = []
    for (let i = 1; i <= beds; i++) { const code = `${name}-${i}`; await db.query(`INSERT INTO bed (site_id, room_id, code) VALUES ($1, $2, $3)`, [siteId, roomId, code]); codes.push(code) }
    return codes
  }
  const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10)
  async function setBackup(on: boolean) {
    await withDb(db => db.query(
      `INSERT INTO config_item (key, scope_site_id, version, value, reason) VALUES ('approvals.escalation_backup', NULL, COALESCE((SELECT max(version) FROM config_item WHERE key = 'approvals.escalation_backup' AND scope_site_id IS NULL), 0) + 1, $1::jsonb, 'e2e')`,
      [JSON.stringify(on)]))
  }

  test.describe.serial('hardening round 1: approvals and re-confirmation (WP-L)', () => {
    test('P-01: a Policy Approver decides an escalated request from the inbox and reserves a bed (proposed policy, switched on)', async ({ page }) => {
      const t = await withDb(async db => {
        const pa = await person(db, 'pa', { role: 'Mgr', caps: ['PolicyApprover'] })
        const res = await person(db, 'res', { role: 'Res' })
        const beds = await room(db, pa.site, `L1-${tag}`, 2)
        // waiting for six days: past the backup level of the approval clock (two business days), as the inbox shows it
        const request = (await db.query<{ id: string }>(
          `INSERT INTO accommodation_request (staff_id, site_id, arrival_date, end_date, stay_type, status, created_at, updated_at) VALUES ($1, $2, $3, $4, 'contract', 'submitted', now() - interval '6 days', now() - interval '6 days') RETURNING id`,
          [res.staff, pa.site, day(10), day(40)])).rows[0].id
        return { pa, res, beds, request }
      })
      await signIn(page, t.pa.emp)
      await page.goto('/approvals')
      const card = page.getByTestId('approval-card').filter({ hasText: t.res.name })
      await expect(card).toBeVisible()
      await expect(card).toContainText('Escalation level')
      await expect(card.getByRole('link', { name: 'Review and allocate' })).toBeVisible() // "mine": the inbox and the API agree
      await card.getByRole('link', { name: 'Review and allocate' }).click()
      await expect(page.getByRole('heading', { name: `Request: ${t.res.name}` })).toBeVisible()
      await page.getByRole('option', { name: new RegExp(t.beds[0]) }).click()
      await page.getByRole('button', { name: /Approve and reserve/ }).last().click()
      const state = () => withDb(async db => (await db.query(`SELECT r.status, (SELECT count(*)::int FROM reservation v WHERE v.request_id = r.id) AS reservations, (SELECT a.actor_role FROM audit_event a WHERE a.entity_id = r.id AND a.action = 'requests.request.approved') AS actor_role FROM accommodation_request r WHERE r.id = $1`, [t.request])).rows[0])
      await expect.poll(async () => (await state()).status, { timeout: 15_000 }).toBe('approved')
      expect(await state()).toMatchObject({ status: 'approved', reservations: 1, actor_role: 'Mgr' })
    })

    test('P-01 off: the inbox says why, the request page is not offered and the API refuses; the setting is put back', async ({ page }) => {
      const t = await withDb(async db => {
        const pa = await person(db, 'pa2', { role: 'Mgr', caps: ['PolicyApprover'] })
        const res = await person(db, 'res2', { role: 'Res' })
        const beds = await room(db, pa.site, `L2-${tag}`, 1)
        const request = (await db.query<{ id: string }>(
          `INSERT INTO accommodation_request (staff_id, site_id, arrival_date, end_date, stay_type, status, created_at, updated_at) VALUES ($1, $2, $3, $4, 'contract', 'submitted', now() - interval '6 days', now() - interval '6 days') RETURNING id`,
          [res.staff, pa.site, day(10), day(40)])).rows[0].id
        const bedId = (await db.query<{ id: string }>(`SELECT id FROM bed WHERE code = $1`, [beds[0]])).rows[0].id
        return { pa, res, request, bedId }
      })
      await setBackup(false)
      try {
        await signIn(page, t.pa.emp)
        await page.goto('/approvals?show=all')
        const card = page.getByTestId('approval-card').filter({ hasText: t.res.name })
        await expect(card).toBeVisible()
        await expect(card).toContainText("Why you can't approve")
        await expect(card).toContainText('switched off')
        await expect(card).toContainText('proposed policy P-01, pending client sign-off')
        await expect(card.getByRole('link', { name: 'Review and allocate' })).toHaveCount(0)
        const refused = await page.request.post(`/api/v1/requests/${t.request}/approve`, { data: { bedId: t.bedId } })
        expect(refused.status()).toBe(403)
        expect(await refused.json()).toMatchObject({ code: 'forbidden', owner: 'Accommodation Admin' })
        const status = await withDb(async db => (await db.query(`SELECT status FROM accommodation_request WHERE id = $1`, [t.request])).rows[0].status)
        expect(status).toBe('submitted')
      } finally { await setBackup(true) }
    })

    test('P-02: the emergency check-in form asks for the password; a wrong one changes nothing', async ({ page }) => {
      const t = await withDb(async db => {
        const rec = await person(db, 'rec', { role: 'Rec', caps: ['EmergencyCheckin'] })
        const evac = await person(db, 'evac', { role: 'Res' })
        const beds = await room(db, rec.site, `L3-${tag}`, 1)
        return { rec, evac, beds }
      })
      await page.setViewportSize({ width: 390, height: 844 })
      await signIn(page, t.rec.emp)
      await page.goto('/emergency')
      await page.getByLabel('Employee ID').fill(t.evac.emp)
      await page.getByRole('button', { name: 'Find person' }).click()
      await expect(page.getByTestId('person-card')).toContainText(t.evac.name)
      const bed = page.getByLabel('Bed', { exact: true })
      await bed.selectOption((await bed.locator('option', { hasText: t.beds[0] }).first().getAttribute('value'))!)
      await page.getByLabel('What happened?').fill('Burst pipe in block C, rooms unusable tonight')
      const submit = page.getByRole('button', { name: 'Create provisional stay' })
      await expect(page.getByLabel('Confirm with your password')).toBeVisible()
      await expect(submit).toBeDisabled() // nothing to send without the password
      await page.getByLabel('Confirm with your password').fill('not-my-password-1')
      await submit.click()
      await expect(page.getByText('Wrong password')).toBeVisible()
      expect(await withDb(async db => (await db.query(`SELECT count(*)::int AS n FROM emergency_checkin WHERE staff_id = $1`, [t.evac.staff])).rows[0].n)).toBe(0)
      await page.getByLabel('Confirm with your password').fill(PASSWORD)
      await submit.click()
      await expect(page.getByText('Provisional stay created')).toBeVisible()
      expect(await withDb(async db => (await db.query(`SELECT count(*)::int AS n FROM emergency_checkin WHERE staff_id = $1`, [t.evac.staff])).rows[0].n)).toBe(1)
    })

    test('P-02: a Super Admin asks for a role; the password is required, a wrong one changes nothing, the right one files it', async ({ page }) => {
      const t = await withDb(async db => ({ target: await person(db, 'tgt', { role: 'Res' }) }))
      await signIn(page, 'E9005')
      await page.goto(`/users/${t.target.user}`)
      await page.getByRole('button', { name: 'Request a role' }).click()
      const form = page.getByRole('dialog', { name: 'Request a role' })
      await form.getByLabel('Role').selectOption('Rec')
      await form.getByLabel('Site').selectOption({ label: 'PV · Palm Villas' })
      await form.getByLabel(/Reason/).fill('Covers the front desk in the evenings')
      const send = form.getByRole('button', { name: 'Send for approval' })
      await expect(send).toBeDisabled()
      await form.getByLabel('Confirm with your password').fill('not-my-password-1')
      await send.click()
      await expect(form.getByText('Wrong password')).toBeVisible()
      expect(await withDb(async db => (await db.query(`SELECT count(*)::int AS n FROM role_change_request WHERE target_user_id = $1`, [t.target.user])).rows[0].n)).toBe(0)
      await form.getByLabel('Confirm with your password').fill(PASSWORD)
      await send.click()
      await expect(page.getByRole('dialog', { name: 'Request a role' })).toHaveCount(0)
      expect(await withDb(async db => (await db.query(`SELECT count(*)::int AS n FROM role_change_request WHERE target_user_id = $1 AND status = 'pending'`, [t.target.user])).rows[0].n)).toBe(1)
    })

    test('P-02: skipping the queue order on the waitlist asks for the password after the reason', async ({ page }) => {
      const t = await withDb(async db => {
        const aa = await db.query<{ id: string }>(`SELECT id FROM site WHERE code = 'PV'`)
        const site = aa.rows[0].id
        const a = await person(db, 'wa', { role: 'Res' })
        const b = await person(db, 'wb', { role: 'Res' })
        const beds = await room(db, site, `L5-${tag}`, 1)
        // far back in time, so nobody else's entry is ahead of these two
        for (const [p, ts] of [[a, '2020-01-01'], [b, '2020-01-02']] as const) {
          await db.query(`INSERT INTO waitlist_entry (staff_id, site_id, queue_ts, expires_at, arrival_date, end_date, stay_type, status) VALUES ($1, $2, $3, now() + interval '10 days', $4, $5, 'contract', 'waiting')`, [p.staff, site, ts, day(10), day(60)])
        }
        return { a, b, beds }
      })
      try {
      await signIn(page, 'E9001')
      await page.goto('/waitlist')
      const row = page.getByTestId('queue-PV').getByRole('row', { name: new RegExp(t.b.name) })
      await expect(row).toBeVisible()
      await row.getByRole('button', { name: 'Offer a bed' }).click()
      const dlg = page.getByRole('dialog', { name: new RegExp(`Offer a bed to ${t.b.name}`) })
      await expect.poll(async () => dlg.getByLabel('Bed to hold').locator('option').count()).toBeGreaterThan(1)
      const options = await dlg.getByLabel('Bed to hold').locator('option').allTextContents()
      await dlg.getByLabel('Bed to hold').selectOption({ index: options.findIndex(o => o.includes(t.beds[0])) })
      await dlg.getByRole('button', { name: 'Hold this bed' }).click()
      // someone is ahead: the form now asks for a reason, and for the password
      await expect(dlg.getByText(/is ahead in the queue/)).toBeVisible()
      await expect(dlg.getByLabel('Confirm with your password')).toBeVisible()
      await dlg.getByLabel('Reason for skipping the queue order').fill('Needs the ground-floor bed')
      await dlg.getByLabel('Confirm with your password').fill('not-my-password-1')
      await dlg.getByRole('button', { name: 'Hold this bed' }).click()
      await expect(dlg.getByText('Wrong password')).toBeVisible()
      expect(await withDb(async db => (await db.query(`SELECT count(*)::int AS n FROM bed_offer WHERE staff_id = $1`, [t.b.staff])).rows[0].n)).toBe(0)
      await dlg.getByLabel('Confirm with your password').fill(PASSWORD)
      await dlg.getByRole('button', { name: 'Hold this bed' }).click()
      await expect(page.getByTestId('queue-PV').getByRole('row', { name: new RegExp(t.b.name) }).getByText('Offered')).toBeVisible()
      const audit = await withDb(async db => (await db.query(`SELECT reason FROM audit_event WHERE action = 'waitlist.offer.created' AND after->>'staffId' = $1`, [t.b.staff])).rows[0])
      expect(audit.reason).toBe('Needs the ground-floor bed')
    } finally {
      // leave nobody ahead of the other specs in the shared Palm Villas queue
      await withDb(async db => {
        await db.query(`UPDATE bed_offer SET status = 'withdrawn' WHERE staff_id = ANY($1) AND status = 'pending'`, [[t.a.staff, t.b.staff]])
        await db.query(`UPDATE waitlist_entry SET status = 'closed', close_reason = 'e2e cleanup', closed_at = now() WHERE staff_id = ANY($1) AND status <> 'closed'`, [[t.a.staff, t.b.staff]])
      })
    }
  })
})
