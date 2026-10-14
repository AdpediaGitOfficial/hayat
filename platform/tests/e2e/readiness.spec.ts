import { randomBytes } from 'node:crypto'
import { expect, test, type Page } from '@playwright/test'
import { Client } from 'pg'
import { hashPassword } from '../../src/server/auth/password'

/**
 * WP-J smoke (run with E2E_PORT=3130): a resident has checked out for real (the checkout command), so the bed needs cleaning.
 *  - Reception sees it on the readiness board with owner and next action, and assigns a housekeeper (the person who lives in the room
 *    is listed but cannot be chosen);
 *  - the housekeeper, on a phone, sees only their room, cannot finish before the required lines are ticked, and marks it cleaned: the bed
 *    is then waiting for inspection, NOT available;
 *  - the inspector fails it with a note and a photo: the bed is back in Needs cleaning with a new task;
 *  - second round, then the inspector passes it: only now is the bed Available;
 *  - the Manager sees a summary, no rows.
 * Every person here is created by this spec (shared database: nothing depends on being alone).
 */
const PASSWORD = 'Welcome-GH-2026'
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(32)])
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

/** The e2e database has a random name; find the one that holds this run's site. */
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

test('checkout, assignment, cleaning on a phone, a failed inspection with a photo, a second round and a pass: the bed is only available at the end', async ({ page, baseURL }) => {
  test.setTimeout(240_000)
  const tag = randomBytes(3).toString('hex').toUpperCase()
  const siteCode = `RDY-${tag}`
  const bedA = `${tag}-A`, bedB = `${tag}-B`, bedC = `${tag}-C`
  const names = { hk: `Hana Housekeeper ${tag}`, neighbour: `Nadia Neighbour ${tag}`, rec: `Rita Reception ${tag}`, insp: `Ivan Inspector ${tag}`, leaver: `Leo Leaver ${tag}` }
  const user = (k: keyof typeof names) => `rdy${k}${tag}`.toLowerCase()
  const password = await hashPassword(PASSWORD)

  /* ---------------- arrange (own site, own people) ---------------- */
  const ids = await (async () => {
    const adminUrl = process.env.TEST_DATABASE_ADMIN_URL ?? 'postgres://postgres@localhost:5432/postgres'
    // The site must exist before withE2eDb can find the database, so create it through the API as the seeded Super Admin.
    await signIn(page, 'E9005')
    const created = await page.request.post('/api/v1/property/sites', { data: { code: siteCode, name: `Readiness site ${tag}`, kind: 'apartment' }, headers: { origin: baseURL! } })
    expect(created.ok()).toBeTruthy()
    void adminUrl
    return withE2eDb(siteCode, async db => {
      const siteId = (await db.query<{ id: string }>(`SELECT id FROM site WHERE code = $1`, [siteCode])).rows[0].id
      const room = (await db.query<{ id: string }>(`INSERT INTO room (site_id, name) VALUES ($1, $2) RETURNING id`, [siteId, `Room ${tag}`])).rows[0].id
      const bed: Record<string, string> = {}
      for (const [l, code] of [['A', bedA], ['B', bedB], ['C', bedC]]) bed[l] = (await db.query<{ id: string }>(`INSERT INTO bed (site_id, room_id, code) VALUES ($1, $2, $3) RETURNING id`, [siteId, room, code])).rows[0].id
      const staff: Record<string, string> = {}
      const person = async (k: keyof typeof names, role: string, scope: 'site' | 'own') => {
        staff[k] = (await db.query<{ id: string }>(`INSERT INTO staff_profile (employee_id, full_name) VALUES ($1, $2) RETURNING id`, [`E${k}${tag}`, names[k]])).rows[0].id
        if (k === 'leaver') return
        const uid = (await db.query<{ id: string }>(`INSERT INTO user_account (staff_id, username, password_hash, must_change_password, status) VALUES ($1, $2, $3, false, 'active') RETURNING id`, [staff[k], user(k), password])).rows[0].id
        await db.query(`INSERT INTO role_assignment (user_id, role, scope_kind, site_id) VALUES ($1, $2, $3, $4)`, [uid, role, scope, scope === 'site' ? siteId : null])
        staff[`${k}:user`] = uid
      }
      await person('hk', 'Res', 'own'); await person('neighbour', 'Res', 'own'); await person('rec', 'Rec', 'site'); await person('insp', 'AA', 'site'); await person('leaver', 'Res', 'own')
      const [maker, checker] = await Promise.all(['E9005', 'E9012'].map(async e => (await db.query<{ id: string }>(`SELECT u.id FROM user_account u JOIN staff_profile s ON s.id = u.staff_id WHERE s.employee_id = $1`, [e])).rows[0].id))
      for (const [k, cap] of [['hk', 'Housekeeping'], ['neighbour', 'Housekeeping'], ['insp', 'FinalInspection']] as const) {
        await db.query(`INSERT INTO capability_grant (user_id, capability, reason, starts_at, status, maker_id, checker_id, decided_at) VALUES ($1, $2, 'e2e', now() - interval '1 day', 'active', $3, $4, now())`, [staff[`${k}:user`], cap, maker, checker])
      }
      const stay = async (b: string, s: string) => {
        const c = (await db.query<{ id: string }>(`INSERT INTO bed_claim (bed_id, kind, period) VALUES ($1, 'stay', $2::daterange) RETURNING id`, [b, `[${iso(-20)},)`])).rows[0].id
        const st = (await db.query<{ id: string }>(`INSERT INTO stay (staff_id, bed_id, claim_id, status, stay_type, checked_in_at) VALUES ($1, $2, $3, 'active', 'contract', now() - interval '20 days') RETURNING id`, [s, b, c])).rows[0].id
        await db.query(`UPDATE bed SET state = 'occupied' WHERE id = $1`, [b])
        return st
      }
      const leaverStay = await stay(bed.A, staff.leaver)
      await stay(bed.B, staff.neighbour) // the other housekeeper lives in this room
      return { siteId, bed, staff, leaverStay }
    })
  })()
  const taskStatuses = () => withE2eDb(siteCode, async db => (await db.query<{ status: string }>(`SELECT status FROM cleaning_task WHERE bed_id = $1 ORDER BY created_at`, [ids.bed.A])).rows.map(r => r.status))
  const bedState = () => withE2eDb(siteCode, async db => (await db.query<{ state: string }>(`SELECT state FROM bed WHERE id = $1`, [ids.bed.A])).rows[0].state)

  /* ---------------- Reception checks the resident out (the real command) ---------------- */
  await signIn(page, user('rec'))
  const out = await page.request.post(`/api/v1/stays/${ids.leaverStay}/checkout`, { data: { note: null }, headers: { origin: baseURL! } })
  expect(out.ok(), await out.text()).toBeTruthy()
  expect(await bedState()).toBe('needs_cleaning')

  /* ---------------- Reception: the board, then assign ---------------- */
  await page.goto('/housekeeping')
  await expect(page.getByRole('heading', { name: 'Housekeeping', level: 1 })).toBeVisible()
  const rowA = page.locator('li[data-bed]', { hasText: bedA })
  await expect(rowA).toContainText('Vacant, awaiting cleaning assignment')
  await expect(rowA).toContainText('Owner: Reception')
  await expect(rowA).toContainText('Next: Assign a housekeeper')
  await expect(page.getByTestId('board-summary')).toContainText('without a housekeeper')
  await rowA.getByRole('button', { name: 'Assign a housekeeper…' }).click()
  const picker = page.getByLabel('Housekeeper', { exact: true })
  await expect(picker.locator('option', { hasText: names.neighbour })).toBeDisabled() // lives in the room (D-26)
  await expect(picker.locator('option', { hasText: names.neighbour })).toContainText('Lives in this room')
  await picker.selectOption(ids.staff.hk)
  await page.getByRole('button', { name: 'Assign', exact: true }).click()
  await expect(rowA).toContainText('Vacant, being cleaned')
  await expect(rowA).toContainText(`Assigned to ${names.hk}`)

  /* ---------------- the housekeeper, on a phone ---------------- */
  await page.setViewportSize({ width: 390, height: 844 })
  await signIn(page, user('hk'))
  await page.goto('/housekeeping')
  await expect(page.getByTestId('my-rooms')).toContainText(`Bed ${bedA}`)
  await expect(page.getByTestId('my-rooms')).not.toContainText(bedB)
  await expect(page.getByTestId('board-summary')).toHaveCount(0) // no board for a housekeeper
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)

  async function cleanIt() {
    await page.getByRole('button', { name: 'Start cleaning' }).click()
    const done = page.getByRole('button', { name: 'Mark cleaned' })
    await expect(done).toBeDisabled() // required lines not ticked
    for (const line of ['Bed linen changed', 'Floor and surfaces cleaned', 'Bathroom cleaned']) await page.getByLabel(line).check()
    await expect(page.getByText('Still to tick: Bins emptied')).toBeVisible()
    await expect(done).toBeDisabled()
    await page.getByLabel('Bins emptied').check()
    await expect(done).toBeEnabled()
    await done.click()
    await expect(page.getByTestId('no-rooms')).toBeVisible()
  }
  await cleanIt()
  expect(await bedState()).toBe('inspection_required') // cleaned, NOT available
  expect(await taskStatuses()).toEqual(['cleaned'])

  /* ---------------- the inspector fails it, with a note and a photo ---------------- */
  await page.setViewportSize({ width: 1280, height: 900 })
  await signIn(page, user('insp'))
  await page.goto('/housekeeping')
  const item = page.locator('li[data-task]', { hasText: bedA })
  await expect(item).toContainText(`Cleaned by ${names.hk}`)
  await item.getByRole('button', { name: 'Fail…' }).click()
  const failBtn = page.getByRole('button', { name: 'Fail and send back to cleaning' })
  await expect(failBtn).toBeDisabled() // a note is mandatory
  await page.getByLabel('What has to be redone').fill('Dust on the wardrobe shelves')
  await page.getByTestId('photo-input').setInputFiles({ name: 'dust.png', mimeType: 'image/png', buffer: PNG })
  await expect(page.getByText('dust.png')).toBeVisible()
  await failBtn.click()
  await expect(page.getByTestId('no-inspections')).toBeVisible()
  expect(await bedState()).toBe('needs_cleaning')
  expect(await taskStatuses()).toEqual(['failed', 'open'])
  await withE2eDb(siteCode, async db => {
    expect((await db.query(`SELECT 1 FROM attachment a JOIN cleaning_task t ON t.id = a.entity_id WHERE a.entity_type = 'cleaning_task' AND t.bed_id = $1 AND t.status = 'failed'`, [ids.bed.A])).rowCount).toBe(1)
  })

  /* ---------------- round two: Reception assigns again, the housekeeper cleans, the inspector passes ---------------- */
  await signIn(page, user('rec'))
  await page.goto('/housekeeping')
  const again = page.locator('li[data-bed]', { hasText: bedA })
  await expect(again).toContainText('Vacant, awaiting cleaning assignment')
  await expect(again).toContainText('Failed inspection')
  await again.getByRole('button', { name: 'Assign a housekeeper…' }).click()
  await page.getByLabel('Housekeeper', { exact: true }).selectOption(ids.staff.hk)
  await page.getByRole('button', { name: 'Assign', exact: true }).click()
  await expect(again).toContainText(`Assigned to ${names.hk}`)

  await page.setViewportSize({ width: 390, height: 844 })
  await signIn(page, user('hk'))
  await page.goto('/housekeeping')
  await expect(page.getByText('Redo: this room did not pass inspection')).toBeVisible()
  await expect(page.getByText('Dust on the wardrobe shelves')).toBeVisible()
  await cleanIt()

  await page.setViewportSize({ width: 1280, height: 900 })
  await signIn(page, user('insp'))
  await page.goto('/housekeeping')
  await page.locator('li[data-task]', { hasText: bedA }).getByRole('button', { name: 'Pass: bed is ready' }).click()
  await expect(page.getByTestId('no-inspections')).toBeVisible()
  expect(await bedState()).toBe('available')
  expect(await taskStatuses()).toEqual(['failed', 'passed'])

  /* ---------------- the board no longer lists it; the Manager sees a summary only ---------------- */
  await signIn(page, user('rec'))
  await page.goto('/housekeeping')
  await expect(page.locator('li[data-bed]', { hasText: bedA })).toHaveCount(0)
  await signIn(page, 'E9040')
  await page.goto('/housekeeping')
  await expect(page.getByText('Summary only')).toBeVisible()
  await expect(page.locator('li[data-bed]')).toHaveCount(0)
})
