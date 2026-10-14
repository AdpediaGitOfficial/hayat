import { readFileSync, readdirSync, readlinkSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { Client } from 'pg'
import { expect, test, type Browser, type Page } from '@playwright/test'

/**
 * WP-H smoke (port 3128): an Accommodation Admin marks an occupied resident as Left on a phone-size screen; the resident's open session
 * dies; the stay stays; Reception and the Maintenance Coordinator complete items on the former employee's behalf; Reception cannot
 * waive; the Policy Approver waives a lost key with a reason, evidence (a photo) and their password; the case closes; rehire is blocked
 * while the person is still in the bed, then goes through; a bulk exit previews and confirms; an overdue case is marked.
 * Everyone here is created by this spec (names and employee IDs carry a tag): the database is shared with the other specs.
 */
const PASSWORD = 'Welcome-GH-2026'
const PORT = Number(process.env.E2E_PORT ?? 3120)
const tag = randomBytes(3).toString('hex').toUpperCase()
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(24)])

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

async function withDb<T>(fn: (db: Client) => Promise<T>): Promise<T> {
  const db = new Client({ connectionString: serverDatabaseUrl() })
  await db.connect()
  try { return await fn(db) } finally { await db.end() }
}

interface Person { staffId: string; userId: string; employeeId: string; name: string }

/** Everything this spec needs: a room with beds at Palm Villas, residents with a login and a stay, a lost key, a Policy Approver. */
async function arrange() {
  return withDb(async db => {
    const site = (await db.query<{ id: string }>(`SELECT id FROM site WHERE code = 'PV'`)).rows[0].id
    const room = (await db.query<{ id: string }>(`INSERT INTO room (site_id, name) VALUES ($1, $2) RETURNING id`, [site, `EX-${tag}`])).rows[0].id
    const bed = async (n: number) => (await db.query<{ id: string }>(`INSERT INTO bed (site_id, room_id, code) VALUES ($1, $2, $3) RETURNING id`, [site, room, `EX-${tag}-${n}`])).rows[0].id
    const beds = [await bed(1), await bed(2), await bed(3), await bed(4)]
    const person = async (label: string, bedId?: string): Promise<Person> => {
      const employeeId = `E-EX-${tag}-${label}`
      const name = `Leaver ${label} ${tag}`
      const staffId = (await db.query<{ id: string }>(`INSERT INTO staff_profile (employee_id, full_name, source) VALUES ($1, $2, 'manual') RETURNING id`, [employeeId, name])).rows[0].id
      const userId = (await db.query<{ id: string }>(
        `INSERT INTO user_account (staff_id, username, password_hash, must_change_password, status) SELECT $1, $2, password_hash, false, 'active' FROM user_account WHERE username = 'E1007' RETURNING id`, [staffId, employeeId])).rows[0].id
      await db.query(`INSERT INTO role_assignment (user_id, role, scope_kind) VALUES ($1, 'Res', 'own')`, [userId])
      if (bedId) {
        const claim = (await db.query<{ id: string }>(`INSERT INTO bed_claim (bed_id, kind, period) VALUES ($1, 'stay', '[2026-10-01,)') RETURNING id`, [bedId])).rows[0].id
        await db.query(`INSERT INTO stay (staff_id, bed_id, claim_id, status, stay_type, checked_in_at) VALUES ($1, $2, $3, 'active', 'permanent', '2026-10-01T10:00:00Z')`, [staffId, bedId, claim])
        await db.query(`UPDATE bed SET state = 'occupied' WHERE id = $1`, [bedId])
      }
      return { staffId, userId, employeeId, name }
    }
    const main = await person('MAIN', beds[0])
    const bulkA = await person('BULKA', beds[1])
    const bulkB = await person('BULKB', beds[2])
    const late = await person('LATE', beds[3])
    // a room key the main leaver lost
    await db.query(`INSERT INTO handover_item (category, item_type, code, site_id, room_id, status, holder_staff_id) VALUES ('key', 'room_key', $1, $2, $3, 'lost', $4)`, [`K-${tag}`, site, room, main.staffId])
    // a Policy Approver: the seeded Manager gets the capability (maker and checker are the two seeded Super Admins)
    const user = async (emp: string) => (await db.query<{ id: string }>(`SELECT u.id FROM user_account u JOIN staff_profile s ON s.id = u.staff_id WHERE s.employee_id = $1`, [emp])).rows[0].id
    const [mgr, maker, checker] = [await user('E9040'), await user('E9005'), await user('E9012')]
    const has = (await db.query(`SELECT 1 FROM capability_grant WHERE user_id = $1 AND capability = 'PolicyApprover' AND status = 'active'`, [mgr])).rowCount
    if (!has) {
      await db.query(
        `INSERT INTO capability_grant (user_id, capability, reason, starts_at, status, maker_id, checker_id, decided_at) VALUES ($1, 'PolicyApprover', 'e2e', now() - interval '1 day', 'active', $2, $3, now())`,
        [mgr, maker, checker])
    }
    return { site, room, beds, main, bulkA, bulkB, late }
  })
}

/** Opens a page in its own browser context, signed in as the resident (their session is the one that must die). */
async function residentSession(browser: Browser, baseURL: string, username: string) {
  const ctx = await browser.newContext({ baseURL })
  const page = await ctx.newPage()
  await signIn(page, username)
  return { ctx, page }
}

test.describe.serial('exit and clearance', () => {
  let a: Awaited<ReturnType<typeof arrange>>
  let caseHref = ''
  test.beforeAll(async () => { a = await arrange() })

  test('an Accommodation Admin marks an occupied resident as Left on a phone: preview, confirm with password, session dead, stay stays', async ({ page, browser, baseURL }) => {
    const res = await residentSession(browser, baseURL!, a.main.employeeId)
    await res.page.goto('/my')
    await expect(res.page.getByRole('heading', { name: 'My accommodation' })).toBeVisible()

    await page.setViewportSize({ width: 390, height: 844 })
    await signIn(page, 'E9001')
    await page.goto(`/exits/new?employeeId=${encodeURIComponent(a.main.employeeId)}`)
    const preview = page.getByTestId('exit-preview')
    await expect(preview).toContainText(a.main.name)
    await expect(preview).toContainText('The stay stays')
    await expect(preview).toContainText('Their login ends now')
    await expect(preview).toContainText(/1 key or asset still held/)

    const mark = page.getByRole('button', { name: `Mark ${a.main.name} as Left` })
    await expect(mark).toBeDisabled() // reason and password first
    await page.getByLabel('Reason').fill('Resigned, last day today')
    await page.getByLabel('Your password').fill('wrong-password-1')
    await mark.click()
    await expect(page.getByText('That password is not right')).toBeVisible() // D-03: nothing happened
    await page.getByLabel('Your password').fill(PASSWORD)
    await mark.click()
    await expect(page.getByTestId('mark-left-done')).toContainText('The login has ended')
    await expect(page.getByTestId('mark-left-done')).toContainText('They stay in the bed until an actual checkout')
    caseHref = (await page.getByRole('link', { name: 'Open the clearance case' }).getAttribute('href'))!
    expect(caseHref).toMatch(/^\/exits\/[0-9a-f-]{36}$/)
    await page.screenshot({ path: process.env.E2E_SCREENSHOT_DIR ? `${process.env.E2E_SCREENSHOT_DIR}/exit-marked-phone.png` : undefined, fullPage: true })

    // the resident's open session is dead on the very next request
    await res.page.goto('/my')
    await expect(res.page).toHaveURL(/\/login/)
    await res.ctx.close()
    await withDb(async db => {
      expect((await db.query(`SELECT status FROM stay s JOIN staff_profile p ON p.id = s.staff_id WHERE p.employee_id = $1`, [a.main.employeeId])).rows[0].status).toBe('active')
      expect((await db.query(`SELECT state FROM bed WHERE id = $1`, [a.beds[0]])).rows[0].state).toBe('occupied')
    })
  })

  test('the case: the stay stays occupied, the lost key is Outstanding and cannot be ticked off, closing is blocked with reason, owner and next action', async ({ page }) => {
    await signIn(page, 'E9001')
    await page.goto(caseHref)
    await expect(page.getByRole('heading', { name: a.main.name })).toBeVisible()
    await expect(page.getByText('Stays occupied until checkout')).toBeVisible()
    const items = page.getByTestId('clearance-items')
    await expect(items.locator('li', { hasText: 'Belongings removed from the room' })).toContainText('Open')
    const key = items.locator('li', { hasText: `Room key K-${tag}` })
    await expect(key).toContainText('Outstanding')
    await expect(key).toContainText('Lost or damaged')
    await expect(key).toContainText('never marked returned')
    await expect(key.getByRole('button', { name: /Mark done/ })).toHaveCount(0)
    const blockers = page.getByTestId('close-blockers')
    await expect(blockers).toContainText('3 mandatory items must be done or waived first')
    await expect(blockers).toContainText('Owner: Reception')
    await expect(blockers).toContainText('Owner: Maintenance Coordinator')
    await expect(blockers).toContainText('Owner: Accommodation Admin')
    await expect(blockers).toContainText(/Next: .*Policy Approver/)
    await expect(page.getByRole('button', { name: 'Close the clearance case' })).toBeDisabled()
    // the AA cannot do the Maintenance Coordinator's inspection, and is told why
    await expect(items.locator('li', { hasText: 'Room inspection' })).toContainText('Only the Maintenance Coordinator completes inspection items')
  })

  test('Reception completes the belongings on their behalf, cannot waive; the Maintenance Coordinator does the inspection', async ({ page }) => {
    await signIn(page, 'E9002')
    await page.goto(caseHref)
    const row = page.getByTestId('clearance-items').locator('li', { hasText: 'Belongings removed from the room' })
    await row.getByRole('button', { name: 'Mark done: Belongings removed from the room' }).click()
    await page.getByLabel('Note').fill('Two bags collected from the room')
    await page.getByRole('button', { name: 'Record as done' }).click()
    await expect(row).toContainText('Done')
    await expect(row).toContainText('on behalf of')
    await expect(row).toContainText('Two bags collected from the room')
    await expect(page.getByRole('button', { name: /Waive/ })).toHaveCount(0)
    await expect(page.getByTestId('case-history')).toContainText('Marked done')

    await signIn(page, 'E9020')
    await page.goto(caseHref)
    const insp = page.getByTestId('clearance-items').locator('li', { hasText: 'Room inspection' })
    await insp.getByRole('button', { name: /Mark done: Room inspection/ }).click()
    await page.getByLabel('Note').fill('No damage')
    await page.getByRole('button', { name: 'Record as done' }).click()
    await expect(insp).toContainText('Done')
    await expect(page.getByRole('button', { name: /Mark done: Belongings/ })).toHaveCount(0) // not the Maintenance Coordinator's item
  })

  test('the Policy Approver waives the lost key with a reason, a photo as evidence and their password; then the AA closes the case', async ({ page }) => {
    await signIn(page, 'E9040')
    await page.goto(caseHref)
    const key = page.getByTestId('clearance-items').locator('li', { hasText: `Room key K-${tag}` })
    await key.getByRole('button', { name: /Waive: Room key/ }).click()
    const dialog = page.getByRole('dialog')
    const waive = dialog.getByRole('button', { name: 'Waive this item' })
    await expect(waive).toBeDisabled()
    await dialog.getByLabel('Reason for the waiver').fill('Key lost on site; the lock was changed at the hotel’s cost')
    await dialog.getByLabel('Evidence', { exact: true }).fill('Security incident report SIR-' + tag)
    await dialog.getByTestId('evidence-input').setInputFiles({ name: 'incident.png', mimeType: 'image/png', buffer: PNG })
    await expect(dialog.getByRole('list', { name: 'Attached evidence' })).toContainText('incident.png')
    await dialog.getByLabel('Your password').fill('wrong-password-1')
    await waive.click()
    await expect(dialog.getByText('That password is not right')).toBeVisible()
    await dialog.getByLabel('Your password').fill(PASSWORD)
    await waive.click()
    await expect(key).toContainText('Waived')
    await expect(key).toContainText(`SIR-${tag}`)
    await expect(key.getByRole('link', { name: 'incident.png' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Close the clearance case' })).toHaveCount(1)

    await signIn(page, 'E9001')
    await page.goto(caseHref)
    await expect(page.getByTestId('close-blockers')).toHaveCount(0)
    await page.getByRole('button', { name: 'Close the clearance case' }).click()
    await expect(page.getByText('Cleared', { exact: true }).first()).toBeVisible()
    await expect(page.getByTestId('case-history')).toContainText('Case closed')
    await expect(page.getByTestId('case-history')).toContainText('Waived by the Policy Approver')
    await withDb(async db => {
      expect((await db.query(`SELECT status FROM stay s JOIN staff_profile p ON p.id = s.staff_id WHERE p.employee_id = $1`, [a.main.employeeId])).rows[0].status).toBe('active') // clearance is not checkout
    })
  })

  test('rehire is blocked while the person is still in the bed (reason, owner, next action), and goes through after the checkout, on the same profile', async ({ page }) => {
    await signIn(page, 'E9001')
    await page.goto(`/exits/rehire?employeeId=${encodeURIComponent(a.main.employeeId)}`)
    await expect(page.getByTestId('rehire-preview')).toContainText('has not been checked out')
    await expect(page.getByTestId('rehire-preview')).toContainText('Owner: Reception')
    await expect(page.getByRole('button', { name: `Rehire ${a.main.name}` })).toHaveCount(0)

    await withDb(async db => { // Reception checks the resident out (done by hand here: the stay screens have their own specs)
      await db.query(`UPDATE stay SET status = 'checked_out', checked_out_at = now() WHERE staff_id = $1`, [a.main.staffId])
      await db.query(`UPDATE bed_claim SET released_at = now(), release_reason = 'checked_out' WHERE id IN (SELECT claim_id FROM stay WHERE staff_id = $1)`, [a.main.staffId])
    })
    await page.reload()
    await page.getByLabel('Reason').fill('Returning on a new contract')
    await page.getByLabel('Your password').fill(PASSWORD)
    await page.getByRole('button', { name: `Rehire ${a.main.name}` }).click()
    await expect(page.getByTestId('rehire-done')).toContainText('active again')
    await withDb(async db => {
      expect((await db.query(`SELECT employment_status FROM staff_profile WHERE employee_id = $1`, [a.main.employeeId])).rows[0].employment_status).toBe('active')
      expect((await db.query(`SELECT count(*)::int AS n FROM staff_profile WHERE employee_id = $1`, [a.main.employeeId])).rows[0].n).toBe(1)
      expect((await db.query(`SELECT status FROM user_account WHERE username = $1`, [a.main.employeeId])).rows[0].status).toBe('revoked') // the login stays off
    })
  })

  test('bulk exit: preview says what will happen to each row and changes nobody; confirm marks them once', async ({ page }) => {
    await signIn(page, 'E9001')
    await page.goto('/exits/bulk')
    await page.getByLabel('Employee IDs').fill([a.bulkA.employeeId, a.bulkB.employeeId, `E-NOBODY-${tag}`].join('\n'))
    await page.getByLabel('Reason').fill('Contract ended, site closing')
    await page.getByRole('button', { name: 'Preview' }).click()
    await expect(page.getByTestId('bulk-counts')).toContainText('2 will be marked')
    await expect(page.getByTestId('bulk-counts')).toContainText('1 not found')
    await expect(page.locator(`[data-row="${a.bulkA.employeeId}"]`)).toContainText('Will be marked')
    await expect(page.locator(`[data-row="E-NOBODY-${tag}"]`)).toContainText('Not found')
    await withDb(async db => {
      expect((await db.query(`SELECT employment_status FROM staff_profile WHERE employee_id = ANY($1)`, [[a.bulkA.employeeId, a.bulkB.employeeId]])).rows.map(r => r.employment_status)).toEqual(['active', 'active'])
    })
    await page.getByLabel('Your password').fill(PASSWORD)
    await page.getByRole('button', { name: 'Mark 2 people as Left' }).click()
    await expect(page.locator(`[data-row="${a.bulkA.employeeId}"]`)).toContainText('Clearance case opened')
    await expect(page.locator(`[data-row="${a.bulkB.employeeId}"]`)).toContainText('Marked')
    await withDb(async db => {
      expect((await db.query(`SELECT count(*)::int AS n FROM clearance_case c JOIN staff_profile p ON p.id = c.staff_id WHERE p.employee_id = ANY($1)`, [[a.bulkA.employeeId, a.bulkB.employeeId]])).rows[0].n).toBe(2)
    })
  })

  test('the list shows open cases first with an overdue badge, and a search narrows it', async ({ page }) => {
    // an open case from long ago for the fourth person (opened by hand: the sweep that reminds about it has its own tests)
    await withDb(async db => {
      const opener = (await db.query<{ id: string }>(`SELECT id FROM user_account WHERE username = 'E9001'`)).rows[0].id
      await db.query(
        `INSERT INTO clearance_case (staff_id, site_id, effective_date, reason, opened_by, opened_at, due_date) VALUES ($1, $2, '2026-01-02', 'Resigned', $3, '2026-01-02T09:00:00Z', '2026-01-09')`, [a.late.staffId, a.site, opener])
      await db.query(`INSERT INTO clearance_item (case_id, kind, checklist_key, label, mandatory, owner, position) SELECT id, 'checklist', 'belongings', 'Belongings removed from the room', true, 'Reception', 1 FROM clearance_case WHERE staff_id = $1`, [a.late.staffId])
    })
    await signIn(page, 'E9001')
    await page.goto(`/exits?q=${encodeURIComponent(tag)}`)
    const list = page.getByRole('list', { name: 'Clearance cases' })
    await expect(list.locator('li').first()).toContainText(a.late.name) // overdue first
    await expect(list.locator('li').first()).toContainText(/Overdue \d+ days?/)
    await expect(list).toContainText(a.bulkA.name)
    await page.getByLabel('Search cases').fill(a.late.employeeId)
    await page.getByRole('button', { name: 'Search' }).click()
    await expect(list.locator('li')).toHaveCount(1)
    await page.goto(`/exits?q=${encodeURIComponent(tag)}&scope=cleared`)
    await expect(page.getByRole('list', { name: 'Clearance cases' })).toContainText(a.main.name)
    // Reception sees the list but is not offered Mark as Left
    await signIn(page, 'E9002')
    await page.goto('/exits')
    await expect(page.getByRole('heading', { name: 'Exits & clearance' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Mark as Left' })).toHaveCount(0)
    await page.goto('/exits/new')
    await expect(page.getByText(/could not be found|not found|404/i).first()).toBeVisible()
  })
})
