import { randomBytes } from 'node:crypto'
import { expect, test, type Page } from '@playwright/test'
import { Client } from 'pg'

/**
 * WP-I smoke (run with E2E_PORT=3129). Everything is arranged for this run: its own site, room, bed, resident and keys.
 *  1. The Accommodation Admin adds keys (one locker key tied to the bed, three room keys in bulk with a per-row result);
 *  2. Reception, on a phone-sized screen, issues the locker key at the desk by typing its code and the employee ID, and the
 *     resident sees it under "My accommodation";
 *  3. the key is reported lost: it cannot be returned (reason, owner and next action), the Admin replaces it, the old key is
 *     retired and linked, the new one is with the same resident;
 *  4. Reception returns the new key at the desk; a key past its due date shows as overdue and is listed under Overdue.
 */
const PASSWORD = 'Welcome-GH-2026'
const iso = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)

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

test('keys: add, issue at the desk on a phone, lost cannot be returned, replace, return, overdue', async ({ page, baseURL }) => {
  test.setTimeout(240_000)
  const tag = randomBytes(3).toString('hex').toUpperCase()
  const siteCode = `KEY-${tag}`
  const bedCode = `KB${tag}`
  const lockerCode = `LK-${tag}`
  const empId = `KR${tag}`
  const resName = `Key Resident ${tag}`

  /* ---------------- arrange: own site, room, bed, resident with an account and a stay ---------------- */
  await signIn(page, 'E9005')
  const created = await page.request.post('/api/v1/property/sites', { data: { code: siteCode, name: `Keys site ${tag}`, kind: 'apartment' }, headers: { origin: baseURL! } })
  expect(created.ok()).toBeTruthy()
  const { hashPassword } = await import('../../src/server/auth/password')
  const siteId = await withE2eDb(siteCode, async db => {
    const siteId = (await db.query<{ id: string }>(`SELECT id FROM site WHERE code = $1`, [siteCode])).rows[0].id
    for (const [username, role] of [['E9001', 'AA'], ['E9002', 'Rec']] as const) {
      await db.query(`INSERT INTO role_assignment (user_id, role, scope_kind, site_id) SELECT id, $2, 'site', $3 FROM user_account WHERE username = $1`, [username, role, siteId])
    }
    const room = (await db.query<{ id: string }>(`INSERT INTO room (site_id, name) VALUES ($1, $2) RETURNING id`, [siteId, `Room ${tag}`])).rows[0].id
    const bed = (await db.query<{ id: string }>(`INSERT INTO bed (site_id, room_id, code) VALUES ($1, $2, $3) RETURNING id`, [siteId, room, bedCode])).rows[0].id
    const s = (await db.query<{ id: string }>(`INSERT INTO staff_profile (employee_id, full_name) VALUES ($1, $2) RETURNING id`, [empId, resName])).rows[0].id
    const u = (await db.query<{ id: string }>(
      `INSERT INTO user_account (staff_id, username, password_hash, must_change_password, status) VALUES ($1, $2, $3, false, 'active') RETURNING id`, [s, empId, await hashPassword(PASSWORD)])).rows[0].id
    await db.query(`INSERT INTO role_assignment (user_id, role, scope_kind) VALUES ($1, 'Res', 'own')`, [u])
    const claim = (await db.query<{ id: string }>(`INSERT INTO bed_claim (bed_id, kind, period) VALUES ($1, 'stay', $2::daterange) RETURNING id`, [bed, `[${iso(-3)},${iso(60)})`])).rows[0].id
    await db.query(`INSERT INTO stay (staff_id, bed_id, claim_id, status, stay_type, checked_in_at) VALUES ($1, $2, $3, 'active', 'contract', now() - interval '3 days')`, [s, bed, claim])
    await db.query(`UPDATE bed SET state = 'occupied' WHERE id = $1`, [bed])
    return siteId
  })

  /* ---------------- 1. the Admin adds keys ---------------- */
  await signIn(page, 'E9001')
  await page.goto('/keys/new')
  await expect(page.getByRole('heading', { name: 'Add keys and assets', level: 1 })).toBeVisible()
  await page.getByLabel('Site').selectOption(siteId)
  await page.getByLabel('Type').selectOption('locker_key')
  await page.getByLabel('Belongs to').selectOption('bed')
  const bedValue = await page.locator('select option', { hasText: `Bed ${bedCode}` }).first().getAttribute('value')
  await page.getByLabel('Bed', { exact: true }).selectOption(bedValue!)
  await page.getByLabel('Code', { exact: true }).fill(lockerCode)
  await page.getByRole('button', { name: 'Add to the cabinet' }).click()
  await expect(page.getByText('Added to the cabinet', { exact: true })).toBeVisible()
  // a duplicate (even in other capitals) is refused with a next action on the field
  await page.getByLabel('Code', { exact: true }).fill(lockerCode.toLowerCase())
  await page.getByRole('button', { name: 'Add to the cabinet' }).click()
  await expect(page.getByText(/already a key with code/).first()).toBeVisible()

  await page.getByRole('tab', { name: 'Many at once' }).click()
  await page.getByLabel('Type').selectOption('room_key')
  await page.getByLabel('Belongs to').selectOption('none')
  await page.getByLabel('Prefix').fill(`RK${tag}-`)
  await page.getByLabel('How many').fill('3')
  await page.getByRole('button', { name: 'Add them all' }).click()
  const bulk = page.getByTestId('bulk-result')
  await expect(bulk.getByText('3 added, 0 not added')).toBeVisible()
  await expect(bulk.getByText(`RK${tag}-02`)).toBeVisible()
  // adding the same list again names every row that was not added
  await page.getByRole('button', { name: 'Add them all' }).click()
  await expect(bulk.getByText('0 added, 3 not added')).toBeVisible()

  /* ---------------- 2. Reception issues it at the desk, on a phone ---------------- */
  await page.setViewportSize({ width: 390, height: 844 })
  await signIn(page, 'E9002')
  await page.goto('/keys')
  await page.getByLabel('Key or asset code').fill(lockerCode)
  await page.getByRole('button', { name: 'Find', exact: true }).click()
  const card = page.getByTestId('desk-item')
  await expect(card.getByText('In cabinet')).toBeVisible()
  await page.getByLabel('Employee ID').fill('NOBODY-HERE')
  await page.getByRole('button', { name: 'Find person' }).click()
  await expect(page.getByText('No staff member with that employee ID')).toBeVisible()
  await page.getByLabel('Employee ID').fill(empId)
  await page.getByRole('button', { name: 'Find person' }).click()
  await expect(page.getByTestId('person-card')).toContainText(resName)
  await page.getByRole('button', { name: new RegExp(`^Issue ${lockerCode}`) }).click()
  await expect(page.getByText(/issued to Key Resident/).first()).toBeVisible()

  // the resident sees it, with what to do
  await page.setViewportSize({ width: 1280, height: 800 })
  await signIn(page, empId)
  await page.goto('/my')
  await expect(page.getByRole('heading', { name: 'My keys and assets' })).toBeVisible()
  await expect(page.getByRole('list', { name: 'Keys and assets I hold' }).getByText(lockerCode)).toBeVisible()

  /* ---------------- 3. lost: cannot be returned; the Admin replaces it ---------------- */
  await signIn(page, 'E9002')
  await page.goto(`/keys?q=${lockerCode}&show=all`)
  await page.getByRole('link', { name: new RegExp(lockerCode) }).first().click()
  await page.getByRole('button', { name: 'Report lost' }).click()
  await page.getByLabel('What happened').fill('Dropped off the jetty')
  await page.getByRole('button', { name: new RegExp(`Record ${lockerCode} as lost`) }).click()
  await expect(page.getByText(/recorded as lost/).first()).toBeVisible()
  await expect(page.getByText('A lost item cannot be marked returned').first()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Record return' })).toHaveCount(0)
  await expect(page.getByText('Owner: Accommodation Admin').first()).toBeVisible()

  await signIn(page, 'E9001')
  await page.goto(`/keys?q=${lockerCode}&show=lost`)
  await page.getByRole('link', { name: new RegExp(lockerCode) }).first().click()
  const newCode = `LK2-${tag}`
  await page.getByRole('button', { name: 'Replace' }).click()
  await page.getByLabel('Code of the new item').fill(newCode)
  await page.getByRole('button', { name: new RegExp(`^Replace ${lockerCode}`) }).click()
  await expect(page.getByText(new RegExp(`${newCode} issued to ${resName}`)).first()).toBeVisible()
  await expect(page.getByText('Retired').first()).toBeVisible()
  await expect(page.getByRole('link', { name: newCode })).toBeVisible()               // "Replaced by"

  /* ---------------- 4. Reception returns the new key; an overdue key is listed ---------------- */
  await signIn(page, 'E9002')
  await page.goto('/keys')
  await page.getByLabel('Key or asset code').fill(newCode)
  await page.getByRole('button', { name: 'Find', exact: true }).click()
  await expect(page.getByTestId('desk-item').getByText(`With ${resName}`)).toBeVisible()
  await page.getByRole('button', { name: new RegExp(`Record the return of ${newCode}`) }).click()
  await expect(page.getByText(/returned/).first()).toBeVisible()

  await withE2eDb(siteCode, async db => {
    const room = `RK${tag}-01`
    // issue a room key directly (as if from the past) with a due date three days ago
    await db.query(`UPDATE handover_item SET status = 'issued', holder_staff_id = (SELECT id FROM staff_profile WHERE employee_id = $2), issued_at = now() - interval '10 days', due_back = $3 WHERE code = $1`, [room, empId, iso(-3)])
  })
  await page.goto('/keys?show=overdue')
  await expect(page.getByRole('link', { name: `RK${tag}-01` })).toBeVisible()
  await expect(page.getByText(/Overdue · past due date/).first()).toBeVisible()
  await expect(page.getByText(/Nothing is returned for you|nothing is marked returned/i).first()).toBeVisible()
})
