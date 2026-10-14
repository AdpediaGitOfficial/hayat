import { randomBytes } from 'node:crypto'
import { expect, test, type Page } from '@playwright/test'
import { Client } from 'pg'

/**
 * WP-D smoke (run with E2E_PORT=3124):
 *  1. a Resident files a request on their phone-sized screen, the Accommodation Admin finds it in the approvals inbox, picks a bed and
 *     approves (one step), and the resident sees the reservation;
 *  2. a female resident asks for a male-only room: the approval is refused with owner and next action, the admin asks a Policy Approver,
 *     who grants the exception with reason and evidence; the approval then works and the exception report shows the use;
 *  3. bulk allocation: preview reserves nothing, confirm reserves the rows and the reservations list shows them.
 */
const PASSWORD = 'Welcome-GH-2026'
const DAY = 86_400_000
const ymd = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10)

async function signIn(page: Page, username: string) {
  await page.context().clearCookies()
  await page.goto('/login')
  await page.getByLabel('Username').fill(username)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { name: /Welcome/ })).toBeVisible()
}

/** The e2e database is created by global setup under a random name; find it by the seeded site Palm Villas (PV). */
async function withE2eDb<T>(fn: (db: Client) => Promise<T>): Promise<T> {
  if (process.env.E2E_DATABASE_URL) { // set by global setup: this run's own database (other runs may share the server)
    const own = new Client({ connectionString: process.env.E2E_DATABASE_URL })
    await own.connect()
    try { return await fn(own) } finally { await own.end() }
  }
  const adminUrl = process.env.TEST_DATABASE_ADMIN_URL ?? 'postgres://postgres@localhost:5432/postgres'
  const admin = new Client({ connectionString: adminUrl })
  await admin.connect()
  try {
    const names = (await admin.query<{ datname: string }>(`SELECT datname FROM pg_database WHERE datname LIKE 'gh\\_e2e\\_%' ORDER BY datname`)).rows.map(r => r.datname)
    for (const name of names) {
      const u = new URL(adminUrl); u.pathname = `/${name}`
      const db = new Client({ connectionString: u.toString() })
      await db.connect()
      try {
        if ((await db.query(`SELECT 1 FROM site WHERE code = 'PV'`)).rowCount && (await db.query(`SELECT 1 FROM staff_profile WHERE employee_id = 'E1007'`)).rowCount) return await fn(db)
      } finally { await db.end() }
    }
  } finally { await admin.end() }
  throw new Error('no e2e database found')
}

async function arrange(tag: string) {
  return withE2eDb(async db => {
    const pv = (await db.query<{ id: string }>(`SELECT id FROM site WHERE code = 'PV'`)).rows[0].id
    const room = (await db.query<{ id: string }>(`INSERT INTO room (site_id, name, gender_policy) VALUES ($1, $2, 'any') RETURNING id`, [pv, `Rq-${tag}`])).rows[0].id
    for (const code of ['A', 'B']) await db.query(`INSERT INTO bed (site_id, room_id, code) VALUES ($1, $2, $3)`, [pv, room, `RQ${tag}-${code}`])
    const maleRoom = (await db.query<{ id: string }>(`INSERT INTO room (site_id, name, gender_policy) VALUES ($1, $2, 'male') RETURNING id`, [pv, `Rm-${tag}`])).rows[0].id
    await db.query(`INSERT INTO bed (site_id, room_id, code) VALUES ($1, $2, $3)`, [pv, maleRoom, `RM${tag}-A`])
    // Leena Verma (Read-only Manager at all sites) is made a Policy Approver by a maker and a different checker (D-27).
    const [maker, checker, leena] = await Promise.all(['E9005', 'E9012', 'E9040'].map(async e => (await db.query<{ id: string }>(
      `SELECT u.id FROM user_account u JOIN staff_profile s ON s.id = u.staff_id WHERE s.employee_id = $1`, [e])).rows[0].id))
    if (!(await db.query(`SELECT 1 FROM capability_grant WHERE user_id = $1 AND capability = 'PolicyApprover' AND status = 'active'`, [leena])).rowCount) {
      await db.query(`INSERT INTO capability_grant (user_id, capability, reason, starts_at, status, maker_id, checker_id, decided_at) VALUES ($1, 'PolicyApprover', 'e2e', now() - interval '1 day', 'active', $2, $3, now())`, [leena, maker, checker])
    }
    return { pv }
  })
}

/** Chooses a bed by its code: from the suggestions if it is one, else from the "any other bed" list (whose text carries room and state too). */
async function pickOtherBed(page: Page, code: string) {
  const suggested = page.getByRole('listbox', { name: 'Suggested beds' }).getByRole('option', { name: new RegExp(code) })
  if (await suggested.count()) return suggested.first().click()
  const value = await page.locator('select option', { hasText: code }).first().getAttribute('value')
  await page.getByLabel('Or choose any other bed at this site').selectOption(value!)
}

async function switchMode(page: Page, from: string, to: string) {
  await page.getByRole('button', { name: new RegExp(`^${from}`) }).click()
  await page.getByRole('menuitemradio', { name: new RegExp(`^${to}`) }).click()
  await expect(page.getByRole('heading', { name: /Welcome/ })).toBeVisible()
}

test('a resident requests a bed on a phone, the AA approves from the inbox in one step, the resident sees the reservation', async ({ page }) => {
  const tag = randomBytes(3).toString('hex').toUpperCase()
  await arrange(tag)

  /* ---- Resident, phone-sized ---- */
  await page.setViewportSize({ width: 390, height: 844 })
  await signIn(page, 'E1007')
  await page.goto('/my')
  await expect(page.getByRole('heading', { name: 'My accommodation' })).toBeVisible()
  await page.getByRole('link', { name: 'Request a bed' }).click()
  await expect(page.getByRole('heading', { name: 'Request a bed', level: 1 })).toBeVisible()
  await page.getByLabel('Site').selectOption({ label: 'Palm Villas' })
  await page.getByLabel('Arrival date').fill(ymd(3))
  await page.getByLabel('Departure day').fill(ymd(33))
  await expect(page.getByTestId('request-preview')).toContainText(/bed.* look free for these dates/)
  // the form never scrolls sideways on a phone
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.getByRole('button', { name: 'Submit request' }).click()
  await expect(page).toHaveURL(/\/my$/)
  await expect(page.getByTestId('my-request')).toContainText('Waiting for an Accommodation Admin to choose a bed')
  await expect(page.getByTestId('my-request')).toContainText('Submitted')

  // one open request per person: a second attempt is blocked before sending, with the reason
  await page.goto('/requests/new')
  await page.getByLabel('Site').selectOption({ label: 'Palm Villas' })
  await page.getByLabel('Arrival date').fill(ymd(5))
  await page.getByLabel('Departure day').fill(ymd(25))
  await expect(page.getByText(/already has? an open request|already have an open request/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Submit request' })).toBeDisabled()

  /* ---- Accommodation Admin ---- */
  await page.setViewportSize({ width: 1280, height: 900 })
  await signIn(page, 'E9001')
  await page.getByRole('button', { name: 'Approvals' }).first().click()
  const card = page.getByTestId('approval-card').filter({ hasText: 'Rahul Menon' })
  await expect(card).toBeVisible()
  await expect(card).toContainText('Route: Accommodation Admin → Policy Approver')
  await expect(card).toContainText('Reminders: 0')
  await card.getByRole('link', { name: 'Review and allocate' }).click()
  await expect(page.getByRole('heading', { name: 'Request: Rahul Menon' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Approve and reserve' })).toBeDisabled()
  await page.getByRole('listbox', { name: 'Suggested beds' }).getByRole('option', { name: /R[MQ][0-9A-F]+-[AB]/ }).first().click()
  await page.getByRole('button', { name: /^Approve and reserve .+/ }).click()
  await expect(page.getByText('Approved: a bed is reserved for you')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Reservation' })).toBeVisible()
  await expect(page.getByTestId('timeline')).toContainText('Approved and bed reserved')

  /* ---- Resident sees it ---- */
  await signIn(page, 'E1007')
  await page.goto('/my')
  await expect(page.getByTestId('my-reservation')).toContainText(/Bed R[MQ][0-9A-F]+-[AB]/)
  await expect(page.getByTestId('my-reservation')).toContainText('Go to Reception when you arrive')
})

test('gender exception: blocked with owner and next action, Policy Approver grants with reason and evidence, then it works and the use is reported', async ({ page }) => {
  const tag = randomBytes(3).toString('hex').toUpperCase()
  await arrange(tag)

  /* ---- Priya (Accommodation Admin at Lakeview AND a Resident) files as a resident ---- */
  await signIn(page, 'E9060')
  await switchMode(page, 'Accommodation Admin', 'Resident')
  await page.goto('/requests/new')
  await page.getByLabel('Site').selectOption({ label: 'Palm Villas' })
  await page.getByLabel('Arrival date').fill(ymd(4))
  await page.getByLabel('Departure day').fill(ymd(34))
  await page.getByRole('button', { name: 'Submit request' }).click()
  await expect(page).toHaveURL(/\/my$/)

  /* ---- AA picks the male-only room's bed: refused, with who owns the next step ---- */
  await signIn(page, 'E9001')
  await page.goto('/requests?q=Priya')
  await page.getByRole('row', { name: /Priya Iyer/ }).getByRole('link').first().click()
  await expect(page.getByRole('heading', { name: /Request: Priya Iyer/ })).toBeVisible()
  await pickOtherBed(page, `RM${tag}-A`)
  await page.getByRole('button', { name: /^Approve and reserve .+/ }).click()
  await expect(page.getByText(/male-only/).first()).toBeVisible()
  await expect(page.getByText('Owner: Policy Approver')).toBeVisible()
  await expect(page.getByText(/Next: Ask a Policy Approver for an exception/)).toBeVisible()
  await page.getByRole('button', { name: 'Ask a Policy Approver for an exception' }).click()
  await page.getByRole('dialog').getByLabel('Why is this exception needed?').fill('Only vacancy near her department')
  await page.getByRole('dialog').getByRole('button', { name: 'Send to Policy Approver' }).click()
  await expect(page.getByText('Waiting for exception').first()).toBeVisible()

  /* ---- Policy Approver ---- */
  await signIn(page, 'E9040')
  await page.getByRole('button', { name: 'Approvals' }).first().click()
  const card = page.getByTestId('approval-card').filter({ hasText: 'Priya Iyer' })
  await expect(card).toContainText('gender exception')
  await card.getByRole('link', { name: 'Review exception' }).click()
  await expect(page.getByRole('heading', { name: 'Exception decision' })).toBeVisible()
  await page.getByLabel('Reason').fill('Approved by the Accommodation Manager')
  await page.getByLabel('Evidence').fill('Email from HR head, 12 Oct')
  await page.getByRole('button', { name: 'Grant exception' }).click()
  await expect(page.getByTestId('timeline')).toContainText('Exception granted')

  /* ---- AA completes the approval ---- */
  await signIn(page, 'E9001')
  await page.goto('/requests?q=Priya')
  await page.getByRole('row', { name: /Priya Iyer/ }).getByRole('link').first().click()
  await expect(page.getByRole('heading', { name: /Request: Priya Iyer/ })).toBeVisible()
  await pickOtherBed(page, `RM${tag}-A`)
  await page.getByRole('button', { name: /^Approve and reserve .+/ }).click()
  await expect(page.getByText('Approved: a bed is reserved for you')).toBeVisible()

  /* ---- the exception report lists the use ---- */
  await signIn(page, 'E9040')
  await page.goto('/approvals/exceptions')
  const row = page.getByTestId('exception-row').filter({ hasText: 'Priya Iyer' })
  await expect(row).toContainText('Gender')
  await expect(row).toContainText('Email from HR head, 12 Oct')
  await expect(row).toContainText('reservation')
})

test('bulk allocation: the preview reserves nothing, confirm reserves each row, and the reservations list shows them', async ({ page }) => {
  const tag = randomBytes(3).toString('hex').toUpperCase()
  const { pv } = await arrange(tag)
  const people = await withE2eDb(async db => {
    const out: string[] = []
    for (const n of [1, 2]) {
      const id = `EB${tag}${n}`
      const s = (await db.query<{ id: string }>(`INSERT INTO staff_profile (employee_id, full_name, gender, grade) VALUES ($1, $2, 'male', 3) RETURNING id`, [id, `Bulk Person ${tag}${n}`])).rows[0].id
      await db.query(`INSERT INTO accommodation_request (staff_id, site_id, arrival_date, end_date, stay_type) VALUES ($1, $2, $3, $4, 'contract')`, [s, pv, ymd(6), ymd(36)])
      out.push(id)
    }
    return out
  })

  await signIn(page, 'E9001')
  await page.goto('/requests/bulk')
  await page.getByLabel('Site').selectOption({ label: 'Palm Villas' })
  await page.getByLabel('Employee IDs').fill(people.join(', '))
  await page.getByRole('button', { name: 'Preview allocation' }).click()
  await expect(page).toHaveURL(/\/requests\/bulk\/[0-9a-f-]{36}$/)
  await expect(page.getByText('Nothing has been reserved yet', { exact: true })).toBeVisible()
  await expect(page.getByTestId('bulk-row')).toHaveCount(2)
  await expect(page.getByTestId('bulk-row').first()).toContainText('Ready to reserve')

  await page.getByRole('button', { name: /^Confirm allocation/ }).click()
  await expect(page.getByTestId('bulk-row').first()).toContainText('Reserved')
  await expect(page.getByTestId('bulk-row').nth(1)).toContainText('Reserved')
  await expect(page.getByText('Every reservable row is done.')).toBeVisible()

  await page.goto(`/requests/reservations?q=Bulk Person ${tag}`)
  await expect(page.getByTestId('reservation-row')).toHaveCount(2)
  await page.getByTestId('reservation-row').first().getByRole('link').first().click()
  await expect(page.getByRole('button', { name: 'Cancel reservation' })).toBeVisible()
  await expect(page.getByRole('button', { name: /Extend no-show deadline/ })).toBeVisible()
})

test('sent back for changes: the resident edits and sends it back, then cancels; the admin sees it each time', async ({ page }) => {
  const tag = randomBytes(3).toString('hex').toUpperCase()
  const username = `EC${tag}`
  const { hashPassword } = await import('../../src/server/auth/password')
  await arrange(tag)
  await withE2eDb(async db => {
    const s = (await db.query<{ id: string }>(`INSERT INTO staff_profile (employee_id, full_name, gender, grade) VALUES ($1, $2, 'male', 3) RETURNING id`, [username, `Carla Cole ${tag}`])).rows[0].id
    const u = (await db.query<{ id: string }>(
      `INSERT INTO user_account (staff_id, username, password_hash, must_change_password, status) VALUES ($1, $2, $3, false, 'active') RETURNING id`,
      [s, username, await hashPassword(PASSWORD)])).rows[0].id
    await db.query(`INSERT INTO role_assignment (user_id, role, scope_kind) VALUES ($1, 'Res', 'own')`, [u])
  })

  await signIn(page, username)
  await page.goto('/requests/new')
  await page.getByLabel('Site').selectOption({ label: 'Palm Villas' })
  await page.getByLabel('Arrival date').fill(ymd(5))
  await page.getByLabel('Departure day').fill(ymd(15))
  await page.getByRole('button', { name: 'Submit request' }).click()
  await expect(page).toHaveURL(/\/my$/)

  // the AA asks for a different departure date: a reason is required
  await signIn(page, 'E9001')
  await page.goto(`/requests?q=${username}`)
  await page.getByRole('row', { name: new RegExp(username) }).getByRole('link').first().click()
  await expect(page.getByRole('heading', { name: /Request: Carla Cole/ })).toBeVisible()
  await page.getByRole('button', { name: 'Send back for changes' }).click()
  const dlg = page.getByRole('dialog', { name: 'Send back for changes' })
  await expect(dlg.getByRole('button', { name: 'Send back' })).toBeDisabled() // no reason yet
  await dlg.getByLabel('Reason').fill('Please confirm the departure date with your manager')
  await dlg.getByRole('button', { name: 'Send back' }).click()
  await expect(page.getByText('Changes requested').first()).toBeVisible()

  // the resident sees the reason, edits and sends it back
  await signIn(page, username)
  await page.goto('/my')
  await expect(page.getByTestId('my-request')).toContainText('Sent back to you: Please confirm the departure date with your manager')
  await page.getByRole('link', { name: 'Edit and send back' }).click()
  await page.getByLabel('Departure day').fill(ymd(40))
  const saved = page.waitForResponse(r => r.request().method() !== 'GET' && r.url().includes('/api/v1/requests/')) // do not navigate away mid-request
  await page.getByRole('button', { name: 'Save and send back' }).click()
  await saved
  await page.goto('/my')
  await expect(page.getByTestId('my-request')).toContainText('Waiting for an Accommodation Admin to choose a bed')

  // and back in the admin's inbox
  await signIn(page, 'E9001')
  await page.goto('/approvals')
  await expect(page.getByTestId('approval-card').filter({ hasText: 'Carla Cole' })).toBeVisible()

  // the resident changes their mind: cancel needs a reason, and the request is gone from the inbox
  await signIn(page, username)
  await page.goto('/my')
  await page.getByRole('button', { name: 'Cancel request' }).click()
  const cancel = page.getByRole('dialog', { name: 'Cancel your request' })
  await cancel.getByLabel('Why are you cancelling?').fill('Found a flat')
  await cancel.getByRole('button', { name: 'Cancel request' }).click()
  await expect(page.getByTestId('my-request')).toContainText('Cancelled: Found a flat')
  await signIn(page, 'E9001')
  await page.goto('/approvals')
  await expect(page.getByTestId('approval-card').filter({ hasText: 'Carla Cole' })).toHaveCount(0)
})
