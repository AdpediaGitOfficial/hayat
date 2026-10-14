import { readFileSync, readdirSync, readlinkSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { Client } from 'pg'
import { expect, test, type Browser, type Page } from '@playwright/test'

const PASSWORD = 'Welcome-GH-2026'
const PORT = Number(process.env.E2E_PORT ?? 3120)

/** Signs in and waits until the next page is up, so a following goto() cannot overtake the sign-in. */
async function signIn(page: Page, username: string, password = PASSWORD, lands: RegExp = /Welcome/) {
  await page.goto('/login')
  await page.getByLabel('Username').fill(username)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { name: lands })).toBeVisible()
}
async function signOut(page: Page) {
  await page.getByRole('button', { name: 'Sign out' }).first().click()
  await expect(page).toHaveURL(/\/login$/)
}

/**
 * The seed has no staff member without an account, and staff records belong to another package, so the test adds one
 * straight to the database the running server uses. The server was started by global setup with DATABASE_URL in its
 * environment: find the process listening on our port and read it (Linux). E2E_DATABASE_URL overrides.
 */
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

async function newStaffWithoutAccount(): Promise<{ employeeId: string; name: string }> {
  const employeeId = `E-ACC-${randomBytes(3).toString('hex')}`
  const name = `Test Person ${employeeId}`
  const db = new Client({ connectionString: serverDatabaseUrl() })
  await db.connect()
  try { await db.query(`INSERT INTO staff_profile (employee_id, full_name, source) VALUES ($1, $2, 'manual')`, [employeeId, name]) } finally { await db.end() }
  return { employeeId, name }
}

async function freshPage(browser: Browser) {
  const ctx = await browser.newContext({ baseURL: `http://localhost:${PORT}` })
  return { page: await ctx.newPage(), close: () => ctx.close() }
}

test('Super Admin creates an account; the person signs in with the temporary password and must change it', async ({ page, browser }) => {
  const staff = await newStaffWithoutAccount()
  await signIn(page, 'E9005')
  await page.goto('/users')
  await expect(page.getByRole('heading', { name: 'Users and access' })).toBeVisible()

  await page.getByRole('button', { name: 'New account' }).click()
  await page.getByLabel('Employee ID').fill(staff.employeeId)
  await page.getByRole('button', { name: 'Create account' }).click()

  // the temporary password is shown once, with a clear warning
  const dialog = page.getByRole('dialog', { name: 'Account created' })
  await expect(dialog.getByText('This password cannot be shown again')).toBeVisible()
  const temp = (await dialog.getByTestId('temp-password').textContent())!.trim()
  expect(temp).toMatch(/^[A-Za-z0-9]{12}$/)
  await expect(dialog.getByText(staff.employeeId, { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: 'I have handed it over' }).click()
  await expect(dialog).toBeHidden()

  // and it is not on the page afterwards
  await expect(page.getByRole('link', { name: staff.name })).toBeVisible()
  await expect(page.locator('body')).not.toContainText(temp)
  await page.getByRole('link', { name: staff.name }).click()
  await expect(page.getByRole('heading', { name: staff.name })).toBeVisible()
  await expect(page.locator('body')).not.toContainText(temp)

  // the new user: first sign-in with the temporary password forces a new one
  const other = await freshPage(browser)
  await signIn(other.page, staff.employeeId, temp, /Choose a new password/)
  await expect(other.page).toHaveURL(/\/change-password$/)
  await other.page.goto('/users')
  await expect(other.page).toHaveURL(/\/change-password$/) // nothing else opens until the password is changed
  await other.page.getByLabel('Temporary password').fill(temp)
  await other.page.getByLabel('New password', { exact: true }).fill('A-brand-new-pass-7')
  await other.page.getByLabel('New password again').fill('A-brand-new-pass-7')
  await other.page.getByRole('button', { name: 'Save password' }).click()
  await expect(other.page.getByRole('heading', { name: /Welcome/ })).toBeVisible()
  await other.page.goto('/users')
  await expect(other.page.getByText('Not found').or(other.page.getByText('could not be found'))).toBeVisible() // a Resident has no Users screen
  await other.close()

  // the old temporary password is dead
  const again = await freshPage(browser)
  await again.page.goto('/login')
  await again.page.getByLabel('Username').fill(staff.employeeId)
  await again.page.getByLabel('Password').fill(temp)
  await again.page.getByRole('button', { name: 'Sign in' }).click()
  await expect(again.page.getByText('Wrong username or password')).toBeVisible()
  await again.close()
})

test('a second Super Admin approves a capability grant, and the audit log shows who did what', async ({ page, browser }) => {
  const staff = await newStaffWithoutAccount()
  await signIn(page, 'E9005')
  await page.goto('/users')
  await page.getByRole('button', { name: 'New account' }).click()
  await page.getByLabel('Employee ID').fill(staff.employeeId)
  await page.getByRole('button', { name: 'Create account' }).click()
  await page.getByRole('dialog', { name: 'Account created' }).getByRole('button', { name: 'I have handed it over' }).click()
  await page.getByRole('link', { name: staff.name }).click()

  // first Super Admin files the grant
  await page.getByRole('button', { name: 'Request a capability' }).click()
  const form = page.getByRole('dialog', { name: 'Request a capability' })
  await form.getByLabel('Capability').selectOption('BackupApprover')
  await form.getByLabel('Reason (required)').fill('Named backup approver for the east block')
  await form.getByRole('button', { name: 'Send for approval' }).click()
  await expect(page.getByText('Waiting for a second Super Admin')).toBeVisible()

  // ... and cannot approve it themselves
  await page.goto('/users/approvals')
  const row = page.getByTestId('pending-grant').filter({ hasText: staff.employeeId })
  await expect(row).toBeVisible()
  await expect(row.getByText('You filed this, so a different Super Admin decides it')).toBeVisible()
  await expect(row.getByRole('button', { name: 'Approve' })).toHaveCount(0)
  await signOut(page)

  // the second Super Admin approves
  await signIn(page, 'E9012')
  await page.goto('/users/approvals')
  const theirs = page.getByTestId('pending-grant').filter({ hasText: staff.employeeId })
  await expect(theirs.getByText('Backup Approver', { exact: true })).toBeVisible()
  await theirs.getByRole('button', { name: 'Approve' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Approve' }).click()
  await expect(page.getByTestId('pending-grant').filter({ hasText: staff.employeeId })).toHaveCount(0)

  // the account page shows it in effect
  await page.goto('/users')
  await page.getByRole('link', { name: staff.name }).click()
  await expect(page.getByText('In effect')).toBeVisible()

  // the audit log has both steps with their actors
  await page.goto('/audit?action=access.grant')
  const requested = page.locator('[data-testid=audit-row][data-action="access.grant.requested"]').first()
  const approved = page.locator('[data-testid=audit-row][data-action="access.grant.approved"]').first()
  await expect(requested).toContainText('E9005')
  await expect(requested).toContainText('Named backup approver for the east block')
  await expect(approved).toContainText('E9012')
  await expect(page.getByText(/append-only/i)).toBeVisible()

  // an Auditor reads it too; an Accommodation Admin does not get the screen
  await signOut(page)
  await signIn(page, 'E9050')
  await page.goto('/audit')
  await expect(page.getByRole('heading', { name: 'Audit log' })).toBeVisible()
  await expect(page.getByText('You see events recorded against your sites')).toBeVisible()
  await signOut(page)
  await signIn(page, 'E9001')
  await expect(page.getByRole('button', { name: 'Audit log' })).toHaveCount(0)
  await page.goto('/audit')
  await expect(page.getByRole('heading', { name: 'Audit log' })).toHaveCount(0)
})

test('configuration: an open decision is flagged, a change is a new version with a reason', async ({ page }) => {
  await signIn(page, 'E9005')
  await page.goto('/config')
  await expect(page.getByRole('heading', { name: 'Configuration' })).toBeVisible()
  await expect(page.getByText(/Open decisions \(/)).toBeVisible()
  const row = page.getByTestId('config-timers.offer_hours')
  await expect(row.getByTestId('config-value')).toHaveText('48')
  await row.getByRole('button', { name: /Change Bed offer lifetime/ }).click()
  const dlg = page.getByRole('dialog')
  await dlg.getByLabel('Value').fill('0')
  await dlg.getByLabel('Reason (required)').fill('Trying an invalid value')
  await dlg.getByRole('button', { name: 'Save new version' }).click()
  await expect(dlg.getByText(/not allowed|too small|Too small/i).first()).toBeVisible() // refused with the field message, nothing saved
  await dlg.getByLabel('Value').fill('72')
  await dlg.getByRole('button', { name: 'Save new version' }).click()
  await expect(page.getByTestId('config-timers.offer_hours').getByTestId('config-value')).toHaveText('72')
  await page.getByTestId('config-timers.offer_hours').getByRole('link', { name: 'History' }).click()
  await expect(page.getByTestId('config-version')).toHaveCount(1)
  await expect(page.getByTestId('config-version').first()).toContainText('v1')
})
