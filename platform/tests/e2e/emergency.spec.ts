import { readFileSync, readdirSync, readlinkSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { Client } from 'pg'
import { expect, test, type Page } from '@playwright/test'

/**
 * WP-G smoke (port 3127): Reception, who holds the Emergency Check-in capability, starts an emergency check-in on a phone-size screen.
 * Reception cannot decide it and is told why. An Accommodation Admin of another site cannot even see it. The AA of the site rejects one
 * (reason mandatory): the resident stays in the bed as Resolution pending and a relocation task opens. The AA approves the other one.
 */
const PASSWORD = 'Welcome-GH-2026'
const PORT = Number(process.env.E2E_PORT ?? 3127)
const tag = randomBytes(3).toString('hex').toUpperCase()

async function signIn(page: Page, username: string) {
  await page.context().clearCookies()
  await page.goto('/login')
  await page.getByLabel('Username').fill(username)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { name: /Welcome/ })).toBeVisible()
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

/** Seed data has sites and people but no beds and no capability grants: arrange a room with beds and Reception's capability. */
async function arrange(names: string[]): Promise<{ ids: string[] }> {
  const db = new Client({ connectionString: serverDatabaseUrl() })
  await db.connect()
  try {
    const site = (await db.query<{ id: string }>(`SELECT id FROM site WHERE code = 'PV'`)).rows[0].id
    const room = (await db.query<{ id: string }>(`INSERT INTO room (site_id, name) VALUES ($1, $2) RETURNING id`, [site, `EM-${tag}`])).rows[0].id
    for (let i = 1; i <= 3; i++) await db.query(`INSERT INTO bed (site_id, room_id, code) VALUES ($1, $2, $3)`, [site, room, `EM-${tag}-${i}`])
    const user = async (emp: string) => (await db.query<{ id: string }>(`SELECT u.id FROM user_account u JOIN staff_profile s ON s.id = u.staff_id WHERE s.employee_id = $1`, [emp])).rows[0].id
    const [rec, maker, checker] = [await user('E9002'), await user('E9005'), await user('E9012')]
    const has = (await db.query(`SELECT 1 FROM capability_grant WHERE user_id = $1 AND capability = 'EmergencyCheckin' AND status = 'active'`, [rec])).rowCount
    if (!has) {
      await db.query(
        `INSERT INTO capability_grant (user_id, capability, reason, starts_at, status, maker_id, checker_id, decided_at) VALUES ($1, 'EmergencyCheckin', 'e2e', now() - interval '1 day', 'active', $2, $3, now())`,
        [rec, maker, checker])
    }
    const ids: string[] = []
    for (const n of names) {
      const emp = `E-EM-${tag}-${n}`
      await db.query(`INSERT INTO staff_profile (employee_id, full_name, source) VALUES ($1, $2, 'manual')`, [emp, `Evacuee ${n} ${tag}`])
      ids.push(emp)
    }
    return { ids }
  } finally { await db.end() }
}

test.describe.serial('emergency check-in', () => {
  let ids: string[] = []
  test.beforeAll(async () => { ({ ids } = await arrange(['One', 'Two'])) })

  test('Reception starts two emergency check-ins on a phone; they stay Provisional and Reception is told why it cannot decide', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await signIn(page, 'E9002')
    await page.goto('/emergency')
    await expect(page.getByRole('heading', { name: 'Emergency check-in' }).first()).toBeVisible()
    for (const [n, emp] of ids.entries()) {
      await page.getByLabel('Employee ID').fill(emp)
      await page.getByRole('button', { name: 'Find person' }).click()
      await expect(page.getByTestId('person-card')).toContainText(`Evacuee ${n === 0 ? 'One' : 'Two'} ${tag}`)
      const bed = page.getByLabel('Bed', { exact: true })
      await expect(bed).toContainText(`EM-${tag}-${n + 1}`)
      await bed.selectOption((await bed.locator('option', { hasText: `EM-${tag}-${n + 1}` }).first().getAttribute('value'))!)
      await page.getByLabel('What happened?').fill('Water leak in block D, rooms unusable tonight')
      await page.getByRole('button', { name: 'Create provisional stay' }).click()
      await expect(page.getByText('Provisional stay created')).toBeVisible()
      await expect(page.getByText(/Status: Provisional/)).toBeVisible()
      await page.getByRole('button', { name: 'Start another' }).click()
    }
    // The initiator sees both cases, with the deadline clock, and cannot decide: reason, owner and next action are shown.
    for (const n of ['One', 'Two']) {
      const card = page.getByTestId('case-card').filter({ hasText: `Evacuee ${n} ${tag}` })
      await expect(card).toBeVisible()
      await expect(card).toContainText('Provisional')
      await expect(card).toContainText('decision deadline')
      await expect(card).toContainText('You started this emergency check-in')
      await expect(card.getByRole('button', { name: 'Approve' })).toHaveCount(0)
    }
    await page.screenshot({ path: process.env.E2E_SCREENSHOT_DIR ? `${process.env.E2E_SCREENSHOT_DIR}/emergency-phone.png` : undefined, fullPage: true })
  })

  test('an AA of another site cannot see the case; the AA of the site rejects one with a reason and approves the other', async ({ page, browser }) => {
    // E9011 is an AA for Lakeview only: the case is "not found" for them
    await signIn(page, 'E9001')
    await page.goto('/emergency')
    const cardOne = page.getByTestId('case-card').filter({ hasText: `Evacuee One ${tag}` })
    await expect(cardOne).toBeVisible()
    const href = await cardOne.getByRole('link', { name: 'Case detail' }).getAttribute('href')
    expect(href).toMatch(/^\/emergency\/[0-9a-f-]{36}$/)
    const other = await browser.newContext({ baseURL: `http://localhost:${PORT}` })
    const op = await other.newPage()
    await signIn(op, 'E9011')
    const r = await op.goto(href!)
    expect(r?.status()).toBe(404)
    await other.close()

    // Reject One: the reason is mandatory
    await cardOne.getByRole('button', { name: 'Reject' }).click()
    const dialog = page.getByRole('dialog')
    const confirm = dialog.getByRole('button', { name: 'Reject and open relocation task' })
    await expect(confirm).toBeDisabled()
    await dialog.getByLabel('Reason for rejecting').fill('Rooms in block C were found for the evacuees')
    await confirm.click()
    await expect(page.getByRole('dialog')).toHaveCount(0)

    // The resident was not moved: the stay is Resolution pending, and a relocation task for the AA is open with a deadline
    const tasks = page.getByTestId('task-list')
    await expect(tasks).toContainText(`Relocate or check out Evacuee One ${tag}`)
    await expect(tasks).toContainText('The resident is still in the bed')
    await expect(tasks).toContainText('deadline')
    await expect(tasks.getByRole('button', { name: 'Mark done' })).toBeVisible()

    // Approve Two
    const cardTwo = page.getByTestId('case-card').filter({ hasText: `Evacuee Two ${tag}` })
    await cardTwo.getByRole('button', { name: 'Approve' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Approve stay' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByText('Recently decided')).toBeVisible()
    await expect(page.getByTestId('case-card').filter({ hasText: `Evacuee Two ${tag}` })).toHaveCount(0)
    await expect(page.getByRole('link', { name: `Evacuee Two ${tag}` })).toBeVisible()
  })
})
