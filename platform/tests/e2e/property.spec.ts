import { randomBytes } from 'node:crypto'
import { expect, test, type Page } from '@playwright/test'
import { Client } from 'pg'

/**
 * WP-A smoke: a Super Admin creates a site; an Accommodation Admin adds a room with beds in one of their sites, blocks a bed,
 * and tries to archive a room that has become occupied: the refusal lists the dependency with its owner and next action.
 */
const PASSWORD = 'Welcome-GH-2026'

async function signIn(page: Page, username: string) {
  await page.context().clearCookies()
  await page.goto('/login')
  await page.getByLabel('Username').fill(username)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { name: /Welcome/ })).toBeVisible()
}

/** The e2e database is created by global setup under a random name; find it by the site we just made through the UI. */
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

test('SA creates a site, AA adds and blocks a bed, and the archive of an occupied room is refused with its dependencies', async ({ page }) => {
  const tag = randomBytes(3).toString('hex').toUpperCase()
  const siteCode = `E2E-${tag}`
  const roomName = `Room-${tag}`

  /* ---- Super Admin creates a site ---- */
  await signIn(page, 'E9005')
  await page.getByRole('button', { name: 'Sites & rooms' }).first().click()
  await expect(page.getByRole('heading', { name: 'Sites & rooms' })).toBeVisible()
  await page.getByRole('button', { name: 'Add site' }).click()
  const dialog = page.getByRole('dialog', { name: 'Add site' })
  await dialog.getByLabel('Code').fill(siteCode)
  await dialog.getByLabel('Name').fill(`Smoke site ${tag}`)
  await dialog.getByRole('button', { name: 'Create site' }).click()
  await expect(page).toHaveURL(/\/sites\/[0-9a-f-]{36}$/)
  await expect(page.getByRole('heading', { name: `Smoke site ${tag}` })).toBeVisible()
  const newSiteUrl = page.url()
  await expect(page.getByText('This site has no beds yet')).toBeVisible()

  /* ---- Accommodation Admin (Palm Villas and Marina) ---- */
  await signIn(page, 'E9001')
  // Another site's id is a plain "not found" for them (AT-002), not a permission page.
  await page.goto(newSiteUrl)
  await expect(page.getByText('This page could not be found')).toBeVisible()

  await page.goto('/sites')
  await expect(page.getByText(`Smoke site ${tag}`)).toHaveCount(0)
  await page.getByRole('link', { name: /Palm Villas/ }).click()
  await expect(page.getByRole('heading', { name: 'Palm Villas' })).toBeVisible()

  await page.getByRole('button', { name: 'Add room' }).click()
  const room = page.getByRole('dialog', { name: 'Add room and beds' })
  await room.getByLabel('Room name').fill(roomName)
  await expect(room.getByText(`Beds to create: PV-ROOM-${tag}-1, PV-ROOM-${tag}-2`)).toBeVisible()
  await room.getByRole('button', { name: 'Create room' }).click()
  await expect(page.getByRole('heading', { name: `Room ${roomName}` })).toBeVisible()
  const roomUrl = page.url()

  /* ---- block a bed with a reason ---- */
  await page.getByRole('link', { name: new RegExp(`Bed PV-ROOM-${tag}-1, available`, 'i') }).click()
  await expect(page.getByRole('heading', { name: `Bed PV-ROOM-${tag}-1` })).toBeVisible()
  await page.getByLabel('Reason to block').fill('Water leak above the bed')
  await page.getByRole('button', { name: /^Block bed/ }).click()
  await expect(page.getByText('Blocked: Water leak above the bed')).toBeVisible()
  await expect(page.getByText('Owner: Accommodation Admin or Maintenance Coordinator')).toBeVisible()
  await expect(page.getByRole('button', { name: /^Unblock bed/ })).toBeVisible()

  /* ---- the room becomes occupied behind the screen; archiving it is refused with the dependency listed ---- */
  await page.goto(roomUrl)
  await page.getByLabel('Archive the active beds below it together with it').check()
  await expect(page.getByText('No resident, reservation, bed offer or open task depends on this.')).toBeVisible()
  await withE2eDb(siteCode, async db => {
    const bed = await db.query<{ id: string }>(`SELECT b.id FROM bed b WHERE b.code = $1`, [`PV-ROOM-${tag}-2`])
    const staff = await db.query<{ id: string }>(`INSERT INTO staff_profile (employee_id, full_name) VALUES ($1, 'Smoke Resident') RETURNING id`, [`SMK${tag}`])
    const claim = await db.query<{ id: string }>(`INSERT INTO bed_claim (bed_id, kind, period) VALUES ($1, 'stay', '[2026-10-01,)') RETURNING id`, [bed.rows[0].id])
    await db.query(`INSERT INTO stay (staff_id, bed_id, claim_id, status, stay_type) VALUES ($1, $2, $3, 'active', 'permanent')`, [staff.rows[0].id, bed.rows[0].id, claim.rows[0].id])
    await db.query(`UPDATE bed SET state = 'occupied' WHERE id = $1`, [bed.rows[0].id])
  })
  await page.getByLabel('Reason for archiving').fill('Room returned to the owner')
  await page.getByRole('button', { name: 'Archive room' }).click()
  const refusal = page.locator('#main').getByRole('alert')
  await expect(refusal).toContainText(/can't be archived/)
  await expect(refusal).toContainText(/1 occupied bed/)
  await expect(page.getByText('A resident is staying in this bed.')).toBeVisible()
  await expect(page.getByText('Owner: Accommodation Admin · Next: Check the resident out or transfer them to another bed, then try again.')).toBeVisible()

  /* ---- after a reload the dependency is on screen before anyone clicks, and archive is not offered ---- */
  await page.reload()
  await expect(page.getByText(/can't be archived yet/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Archive room' })).toBeDisabled()
})
