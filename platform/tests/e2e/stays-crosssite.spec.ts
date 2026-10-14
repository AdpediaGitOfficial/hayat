import { randomBytes } from 'node:crypto'
import { expect, test, type Page } from '@playwright/test'
import { Client } from 'pg'

/**
 * WP-K smoke (run with E2E_PORT=3131): a transfer across sites (D-104). A resident, on a phone-sized screen, picks another SITE and
 * then a bed of it (beds they cannot have there are listed with the reason); the Accommodation Admin of the source site approves
 * (half), Reception sees it is not ready and why, the Accommodation Admin of the destination site approves, Reception carries it out,
 * and the stay now belongs to the destination site (the old site's admin no longer sees it). Own site, rooms, beds and people.
 */
const PASSWORD = 'Welcome-GH-2026'
const DAY = 86_400_000
const iso = (offset: number) => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10)

async function signIn(page: Page, username: string) {
  await page.context().clearCookies()
  await page.goto('/login')
  await page.getByLabel('Username').fill(username)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { name: /Welcome/ })).toBeVisible()
}

/** The e2e database has a random name; find the one that holds the site this run created. */
async function withE2eDb<T>(siteCode: string, fn: (db: Client) => Promise<T>): Promise<T> {
  if (process.env.E2E_DATABASE_URL) { // set by global setup: this run's own database (other runs may share the server)
    const own = new Client({ connectionString: process.env.E2E_DATABASE_URL })
    await own.connect()
    try { return await fn(own) } finally { await own.end() }
  }
  const adminUrl = process.env.TEST_DATABASE_ADMIN_URL ?? 'postgres://postgres@localhost:5432/postgres'
  const admin = new Client({ connectionString: adminUrl })
  await admin.connect()
  try {
    const names = (await admin.query<{ datname: string }>(`SELECT datname FROM pg_database WHERE datname LIKE 'gh\\_e2e\\_%'`)).rows.map(r => r.datname)
    for (const name of names) {
      const u = new URL(adminUrl); u.pathname = `/${name}`
      const db = new Client({ connectionString: u.toString() })
      await db.connect()
      try {
        if ((await db.query(`SELECT 1 FROM site WHERE code = $1`, [siteCode])).rowCount) return await fn(db)
      } finally { await db.end() }
    }
  } finally { await admin.end() }
  throw new Error(`no e2e database holds site ${siteCode}`)
}

test('a resident asks to move to another site; both sites\' admins approve; Reception moves them; the stay is the new site\'s', async ({ page }) => {
  test.setTimeout(240_000)
  const tag = randomBytes(3).toString('hex').toUpperCase()
  const srcCode = `XS-${tag}`, dstCode = `XD-${tag}`
  const srcName = `Cross Source ${tag}`, dstName = `Cross Destination ${tag}`
  const resName = `Cross Resident ${tag}`
  const users = { res: `XR${tag}`, aaSrc: `XA${tag}`, aaDst: `XB${tag}`, recDst: `XC${tag}` }
  const code = (l: string) => `${tag}-${l}`
  const { hashPassword } = await import('../../src/server/auth/password')
  const hash = await hashPassword(PASSWORD)

  /* ---------------- arrange: two sites, rooms and beds, four people, one active stay ---------------- */
  // The first site is created through the API as a Super Admin (so the e2e database exists and is seeded); the rest is arranged directly.
  await signIn(page, 'E9005')
  const created = await page.request.post('/api/v1/property/sites', { data: { code: srcCode, name: srcName, kind: 'apartment' } })
  expect(created.ok()).toBeTruthy()
  await withE2eDb(srcCode, async db => {
    const src = (await db.query<{ id: string }>(`SELECT id FROM site WHERE code = $1`, [srcCode])).rows[0].id
    const dst = (await db.query<{ id: string }>(`INSERT INTO site (code, name, kind) VALUES ($1, $2, 'apartment') RETURNING id`, [dstCode, dstName])).rows[0].id
    const room = async (siteId: string, name: string, gender: 'any' | 'female') => (await db.query<{ id: string }>(`INSERT INTO room (site_id, name, gender_policy) VALUES ($1, $2, $3) RETURNING id`, [siteId, name, gender])).rows[0].id
    const bed = async (siteId: string, roomId: string, c: string) => (await db.query<{ id: string }>(`INSERT INTO bed (site_id, room_id, code) VALUES ($1, $2, $3) RETURNING id`, [siteId, roomId, c])).rows[0].id
    const bedA = await bed(src, await room(src, `Source room ${tag}`, 'any'), code('A'))
    const mixed = await room(dst, `Mixed ${tag}`, 'any')
    await bed(dst, mixed, code('M1')); await bed(dst, mixed, code('M2'))
    await bed(dst, await room(dst, `Women ${tag}`, 'female'), code('W1'))

    const person = async (username: string, fullName: string, role: 'Res' | 'AA' | 'Rec', siteId: string | null) => {
      const s = (await db.query<{ id: string }>(`INSERT INTO staff_profile (employee_id, full_name, gender, grade) VALUES ($1, $2, 'male', 5) RETURNING id`, [username, fullName])).rows[0].id
      const u = (await db.query<{ id: string }>(`INSERT INTO user_account (staff_id, username, password_hash, must_change_password, status) VALUES ($1, $2, $3, false, 'active') RETURNING id`, [s, username, hash])).rows[0].id
      await db.query(`INSERT INTO role_assignment (user_id, role, scope_kind, site_id) VALUES ($1, $2, $3, $4)`, [u, role, siteId ? 'site' : 'own', siteId])
      return s
    }
    const resident = await person(users.res, resName, 'Res', null)
    await person(users.aaSrc, `Source Admin ${tag}`, 'AA', src)
    await person(users.aaDst, `Destination Admin ${tag}`, 'AA', dst)
    await person(users.recDst, `Destination Reception ${tag}`, 'Rec', dst)
    const claim = (await db.query<{ id: string }>(`INSERT INTO bed_claim (bed_id, kind, period) VALUES ($1, 'stay', $2::daterange) RETURNING id`, [bedA, `[${iso(-5)},${iso(40)})`])).rows[0].id
    await db.query(`INSERT INTO stay (staff_id, bed_id, claim_id, status, stay_type, checked_in_at) VALUES ($1, $2, $3, 'active', 'contract', now() - interval '5 days')`, [resident, bedA, claim])
    await db.query(`UPDATE bed SET state = 'occupied' WHERE id = $1`, [bedA])
  })

  /* ---------------- the resident, on a phone ---------------- */
  await signIn(page, users.res)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/my')
  await expect(page.getByRole('heading', { name: 'My accommodation' })).toBeVisible()
  await expect(page.getByText(`Source room ${tag}`).first()).toBeVisible()
  await page.getByLabel('Move to').selectOption({ label: dstName })
  await expect(page.getByText(`A move into ${dstName} needs two approvals`)).toBeVisible()
  // beds they cannot have there are listed, with the reason in plain words; the others can be chosen
  await expect(page.getByRole('list', { name: 'Beds that are not available to you' })).toContainText(`Women ${tag}`)
  await expect(page.getByRole('list', { name: 'Beds that are not available to you' })).toContainText('female-only')
  await expect(page.getByLabel('Preferred bed').locator('option', { hasText: code('W1') })).toHaveCount(0)
  await page.getByLabel('Preferred bed').selectOption({ label: `Mixed ${tag} · ${code('M1')}` })
  await page.getByLabel('Reason').last().fill('Joining the project in the other site')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true) // no sideways scroll on a phone
  await page.getByRole('button', { name: 'Request move' }).click()
  await expect(page.getByRole("heading", { name: `Move to ${dstName} requested` })).toBeVisible()
  await expect(page.getByText(`Waiting for the Accommodation Admin of ${srcName} and the Accommodation Admin of ${dstName}`).first()).toBeVisible()
  await expect(page.getByText('You stay where you are until both sites have approved').first()).toBeVisible()

  /* ---------------- the source site's Accommodation Admin: half of it ---------------- */
  await page.setViewportSize({ width: 1280, height: 900 })
  await signIn(page, users.aaSrc)
  await page.goto('/stays/transfers')
  const cardOf = () => page.locator('section', { hasText: `Move: ${resName}` })
  await expect(cardOf()).toContainText(`Out of ${srcName}`)
  await expect(cardOf()).toContainText(`Waiting for the Accommodation Admin of ${dstName}`)
  await expect(cardOf().getByRole('button', { name: `Approve: take them into ${dstName}` })).toHaveCount(0) // not their key
  await cardOf().getByRole('button', { name: `Approve: let them leave ${srcName}` }).click()
  await expect(page.getByText('Your approval is recorded').first()).toBeVisible()
  await expect(cardOf()).toContainText('Half approved')
  await expect(cardOf()).toContainText(`Waiting for the Accommodation Admin of ${dstName}`)
  await expect(cardOf().getByRole('button', { name: /Carry out/ })).toHaveCount(0)

  /* ---------------- Reception of the destination: not ready, with reason, owner and next action ---------------- */
  await signIn(page, users.recDst)
  await page.goto('/stays/transfers')
  await expect(cardOf()).toContainText(`Waiting for the Accommodation Admin of ${dstName}`)
  await expect(cardOf()).toContainText('Owner: Accommodation Admin of')
  await expect(cardOf()).toContainText('Next:')
  await expect(cardOf().getByRole('button', { name: /Carry out/ })).toHaveCount(0)

  /* ---------------- the destination site's Accommodation Admin: the other half ---------------- */
  await signIn(page, users.aaDst)
  await page.goto('/stays/transfers')
  await expect(cardOf()).toContainText('Approved by the Accommodation Admin') // the source site's key is shown
  await expect(cardOf().getByLabel('Destination bed')).toBeVisible()           // they choose the bed there
  await cardOf().getByRole('button', { name: `Approve: take them into ${dstName}` }).click()
  await expect(page.getByText('approved by both sites').first()).toBeVisible()

  /* ---------------- Reception carries it out ---------------- */
  await signIn(page, users.recDst)
  await page.goto('/stays/transfers')
  await expect(cardOf()).toContainText('Approved: waiting for Reception')
  await cardOf().getByRole('button', { name: /Carry out move now/ }).click()
  await expect(page.getByText(/^Moved to /).first()).toBeVisible()

  await withE2eDb(srcCode, async db => {
    const row = (await db.query<{ code: string; site: string }>(`SELECT b.code, s.name AS site FROM stay st JOIN staff_profile p ON p.id = st.staff_id JOIN bed b ON b.id = st.bed_id JOIN site s ON s.id = b.site_id WHERE p.full_name = $1 AND st.status = 'active'`, [resName])).rows
    expect(row).toEqual([{ code: code('M1'), site: dstName }])
    expect((await db.query(`SELECT state FROM bed WHERE code = $1`, [code('A')])).rows[0].state).toBe('needs_cleaning')
    expect((await db.query(`SELECT 1 FROM audit_event WHERE action IN ('stays.transfer.executed', 'stays.transfer.received') AND after->>'toSiteId' IS NOT NULL AND entity_id = (SELECT id FROM transfer_request WHERE staff_id = (SELECT id FROM staff_profile WHERE full_name = $1))`, [resName])).rowCount).toBe(2)
  })

  /* ---------------- the stay belongs to the destination site now ---------------- */
  await signIn(page, users.res)
  await page.goto('/my')
  await expect(page.getByText(dstName).first()).toBeVisible()
  await signIn(page, users.aaSrc)
  await page.goto('/stays')
  await expect(page.getByRole('row', { name: new RegExp(resName) })).toHaveCount(0)
  await signIn(page, users.aaDst)
  await page.goto('/stays')
  await expect(page.getByRole('row', { name: new RegExp(resName) })).toHaveCount(1)
})
