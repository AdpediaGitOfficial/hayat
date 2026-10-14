import { randomBytes } from 'node:crypto'
import { expect, test, type Page } from '@playwright/test'
import { Client } from 'pg'

/**
 * WP-F smoke (run with E2E_PORT=3126): Reception checks arrivals in from a phone-sized screen (a bed that is not ready is
 * blocked with reason, owner and next action; bulk check-in), a resident asks for an extension, a move and a checkout from
 * "My accommodation", an Accommodation Admin decides, a move whose destination is blocked behind the screen fails safely
 * and is retried with another bed, Reception checks the resident out.
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

/** Moves a bed along legal transitions (the database guards them). */
async function bedTo(db: Client, bedId: string, path: string[]) {
  for (const s of path) await db.query(`UPDATE bed SET state = $2 WHERE id = $1`, [bedId, s])
}

test('check-in, extension, move that fails safely and is retried, and checkout', async ({ page, baseURL }) => {
  test.setTimeout(240_000)
  const tag = randomBytes(3).toString('hex').toUpperCase()
  const siteCode = `STY-${tag}`
  const code = (l: string) => `${tag}-${l}`
  const one = `Arrival One ${tag}`, two = `Arrival Two ${tag}`, late = `Overdue Person ${tag}`

  /* ---------------- arrange: a site with six beds, the cast, today's arrivals ---------------- */
  await signIn(page, 'E9005')
  const created = await page.request.post('/api/v1/property/sites', { data: { code: siteCode, name: `Stays site ${tag}`, kind: 'apartment' }, headers: { origin: baseURL! } })
  expect(created.ok()).toBeTruthy()
  const ids = await withE2eDb(siteCode, async db => {
    const siteId = (await db.query<{ id: string }>(`SELECT id FROM site WHERE code = $1`, [siteCode])).rows[0].id
    for (const [username, role] of [['E9001', 'AA'], ['E9002', 'Rec']] as const) {
      await db.query(`INSERT INTO role_assignment (user_id, role, scope_kind, site_id) SELECT id, $2, 'site', $3 FROM user_account WHERE username = $1`, [username, role, siteId])
    }
    const room = (await db.query<{ id: string }>(`INSERT INTO room (site_id, name) VALUES ($1, $2) RETURNING id`, [siteId, `Room ${tag}`])).rows[0].id
    const bed: Record<string, string> = {}
    for (const l of ['A', 'B', 'C', 'D', 'E', 'F']) bed[l] = (await db.query<{ id: string }>(`INSERT INTO bed (site_id, room_id, code) VALUES ($1, $2, $3) RETURNING id`, [siteId, room, code(l)])).rows[0].id
    const staff = async (name: string, emp: string) => (await db.query<{ id: string }>(`INSERT INTO staff_profile (employee_id, full_name) VALUES ($1, $2) RETURNING id`, [emp, name])).rows[0].id
    const [s1, s2, s3] = [await staff(one, `A1${tag}`), await staff(two, `A2${tag}`), await staff(late, `OD${tag}`)]
    const reserve = async (b: string, s: string, from: string, to: string) => {
      const c = (await db.query<{ id: string }>(`INSERT INTO bed_claim (bed_id, kind, period) VALUES ($1, 'reservation', $2::daterange) RETURNING id`, [b, `[${from},${to})`])).rows[0].id
      await db.query(`INSERT INTO reservation (staff_id, bed_id, claim_id, eta, source, stay_type) VALUES ($1, $2, $3, now(), 'request', 'contract')`, [s, b, c])
    }
    await reserve(bed.A, s1, iso(0), iso(20))
    await reserve(bed.B, s2, iso(0), iso(20))
    await bedTo(db, bed.B, ['blocked', 'needs_cleaning'])
    // Rahul Menon (E1007, the seeded resident) lives in bed C; another resident is overdue in bed D
    const rahul = (await db.query<{ id: string }>(`SELECT id FROM staff_profile WHERE employee_id = 'E1007'`)).rows[0].id
    const stay = async (b: string, s: string, from: string, to: string) => {
      const c = (await db.query<{ id: string }>(`INSERT INTO bed_claim (bed_id, kind, period) VALUES ($1, 'stay', $2::daterange) RETURNING id`, [b, `[${from},${to})`])).rows[0].id
      const st = (await db.query<{ id: string }>(`INSERT INTO stay (staff_id, bed_id, claim_id, status, stay_type, checked_in_at) VALUES ($1, $2, $3, 'active', 'contract', now() - interval '5 days') RETURNING id`, [s, b, c])).rows[0].id
      await db.query(`UPDATE bed SET state = 'occupied' WHERE id = $1`, [b])
      return st
    }
    const rahulStay = await stay(bed.C, rahul, iso(-5), iso(20))
    await stay(bed.D, s3, iso(-30), iso(-2))
    return { siteId, bed, rahulStay }
  })

  /* ---------------- Reception, on a phone ---------------- */
  await signIn(page, 'E9002')
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/stays')
  await expect(page.getByRole('heading', { name: 'Stays & check-in' })).toBeVisible()
  const cardOne = page.locator('li', { hasText: one })
  const cardTwo = page.locator('li', { hasText: two })
  await expect(cardOne).toContainText('Expected')
  await expect(cardTwo).toContainText('Not ready')
  // a bed that is not ready is blocked with reason, owner and next action; there is no way to check in
  await expect(cardTwo).toContainText(/needs cleaning/i)
  await expect(cardTwo).toContainText('Owner: Housekeeping')
  await expect(cardTwo).toContainText(/Next: Wait for cleaning and the final inspection/)
  await expect(page.getByRole('button', { name: `Check in ${two}` })).toBeDisabled()
  await expect(page.getByRole('row', { name: new RegExp(late) })).toContainText('Overdue 2 days')

  await page.getByRole('button', { name: `Check in ${one}` }).click()
  await expect(page.getByText('Checked in to')).toBeVisible()
  await expect(cardOne).toHaveCount(0)
  await withE2eDb(siteCode, async db => {
    expect((await db.query(`SELECT 1 FROM stay s JOIN staff_profile p ON p.id = s.staff_id WHERE p.full_name = $1 AND s.status = 'active'`, [one])).rowCount).toBe(1)
    expect((await db.query(`SELECT state FROM bed WHERE code = $1`, [code('A')])).rows[0].state).toBe('occupied')
  })

  // the bed is cleaned and inspected (Stage 3 will do this); bulk check-in then takes the second arrival
  await withE2eDb(siteCode, async db => bedTo(db, ids.bed.B, ['inspection_required', 'available']))
  await page.reload()
  await expect(cardTwo).toContainText('Expected')
  await page.getByLabel(`Select ${two}`).check()
  await page.getByRole('button', { name: 'Check in selected (1)' }).click()
  await expect(page.getByRole('list', { name: 'Bulk check-in result' })).toContainText('Checked in')

  /* ---------------- the resident asks (also from a phone) ---------------- */
  await signIn(page, 'E1007')
  await page.goto('/my')
  await expect(page.getByRole('heading', { name: 'My accommodation' })).toBeVisible()
  await expect(page.getByText(`Room ${tag}`).first()).toBeVisible()
  await page.getByLabel('New departure day').fill(iso(30))
  await page.getByRole('button', { name: 'Request extension' }).click()
  await expect(page.getByText('Extension requested', { exact: true })).toBeVisible()
  await expect(page.getByText('Waiting for an Accommodation Admin')).toBeVisible()
  await page.getByLabel('Preferred bed').selectOption({ label: `Room ${tag} · ${code('E')}` })
  await page.getByLabel('Reason').last().fill('Closer to the lift')
  await page.getByRole('button', { name: 'Request move' }).click()
  await expect(page.getByText('Move requested')).toBeVisible()
  await expect(page.getByText('Waiting for an Accommodation Admin').first()).toBeVisible()

  /* ---------------- the Accommodation Admin decides ---------------- */
  await page.setViewportSize({ width: 1280, height: 900 })
  await signIn(page, 'E9001')
  await page.goto('/stays')
  const waiting = page.getByRole('list', { name: 'Requests waiting' })
  await expect(waiting).toContainText('Rahul Menon')
  await waiting.getByRole('button', { name: 'Approve extension' }).click()
  await expect(page.getByText(`Stay extended until ${iso(30)}`)).toBeVisible()
  await page.goto('/stays/transfers')
  const move = page.locator('section', { hasText: 'Move: Rahul Menon' })
  await expect(move).toContainText('Waiting for approval')
  await move.getByLabel('Destination bed').selectOption({ label: `Room ${tag} · ${code('E')}` })
  await move.getByRole('button', { name: 'Approve transfer' }).click()
  await expect(page.getByText('Transfer approved')).toBeVisible()

  /* ---------------- the destination is blocked behind the screen: the move fails safely (AT-022) ---------------- */
  await withE2eDb(siteCode, async db => bedTo(db, ids.bed.E, ['blocked']))
  await signIn(page, 'E9002')
  await page.goto('/stays/transfers')
  const approved = page.locator('section', { hasText: 'Move: Rahul Menon' })
  await expect(approved).toContainText('Approved: waiting for Reception')
  await approved.getByRole('button', { name: 'Carry out move now' }).click()
  await expect(approved.getByRole('alert')).toContainText(/blocked/i)
  await expect(approved.getByRole('alert')).toContainText('Owner:')
  await expect(approved.getByRole('alert')).toContainText('Next:')
  await page.reload()
  await expect(page.locator('section', { hasText: 'Move: Rahul Menon' })).toContainText('Failed: nobody moved')
  await withE2eDb(siteCode, async db => {
    const s = (await db.query(`SELECT bed_id FROM stay WHERE id = $1`, [ids.rahulStay])).rows[0]
    expect(s.bed_id).toBe(ids.bed.C)
    expect((await db.query(`SELECT state FROM bed WHERE id = $1`, [ids.bed.C])).rows[0].state).toBe('occupied')
  })

  // the Accommodation Admin chooses another bed and approves again; Reception carries it out
  await signIn(page, 'E9001')
  await page.goto('/stays/transfers')
  const failed = page.locator('section', { hasText: 'Move: Rahul Menon' })
  await expect(failed).toContainText('Failed: nobody moved')
  await failed.getByLabel('Destination bed').selectOption({ label: `Room ${tag} · ${code('F')}` })
  await failed.getByRole('button', { name: 'Approve with this bed' }).click()
  await expect(page.getByText('Transfer approved')).toBeVisible()
  await signIn(page, 'E9002')
  await page.goto('/stays/transfers')
  await page.locator('section', { hasText: 'Move: Rahul Menon' }).getByRole('button', { name: 'Carry out move now' }).click()
  await expect(page.getByText(/Moved to/)).toBeVisible()
  await withE2eDb(siteCode, async db => {
    expect((await db.query(`SELECT bed_id FROM stay WHERE id = $1`, [ids.rahulStay])).rows[0].bed_id).toBe(ids.bed.F)
    expect((await db.query(`SELECT state FROM bed WHERE id = $1`, [ids.bed.C])).rows[0].state).toBe('needs_cleaning')
    expect((await db.query(`SELECT state FROM bed WHERE id = $1`, [ids.bed.F])).rows[0].state).toBe('occupied')
  })

  /* ---------------- the resident leaves ---------------- */
  await signIn(page, 'E1007')
  await page.goto('/my')
  await page.getByLabel('Departure day', { exact: true }).fill(iso(3))
  await page.getByRole('button', { name: 'Request checkout' }).click()
  await expect(page.getByText('Checkout requested', { exact: true })).toBeVisible()
  await signIn(page, 'E9002')
  await page.goto('/stays')
  const checkout = page.getByRole('list', { name: 'Requests waiting' })
  await expect(checkout).toContainText('Needs acknowledgement')
  await checkout.getByRole('button', { name: 'Acknowledge' }).click()
  await expect(checkout).toContainText('Acknowledged')
  await checkout.getByRole('button', { name: 'Check out now' }).click()
  await checkout.getByRole('button', { name: 'Confirm checkout' }).click()
  await expect(page.getByText(/Checked out\. The bed now needs cleaning/)).toBeVisible()
  await withE2eDb(siteCode, async db => {
    expect((await db.query(`SELECT status FROM stay WHERE id = $1`, [ids.rahulStay])).rows[0].status).toBe('checked_out')
    expect((await db.query(`SELECT state FROM bed WHERE id = $1`, [ids.bed.F])).rows[0].state).toBe('needs_cleaning')
  })
  await signIn(page, 'E1007')
  await page.goto('/my')
  await expect(page.getByText(/You checked out of/)).toBeVisible()
})
