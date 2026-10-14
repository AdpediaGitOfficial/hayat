import { randomBytes } from 'node:crypto'
import { Client } from 'pg'
import { expect, test, type Page } from '@playwright/test'

/**
 * Hardening round, WP-M smoke (run with E2E_PORT=3141). The proposed policies P-03 to P-08 are PENDING CLIENT SIGN-OFF and sit behind
 * settings; this spec turns each on and off through the settings table (a new version each time, as the System configuration screen does)
 * and always puts the shipped default back. Everything it needs it creates itself (own site, room, beds, people, keys: tagged), because the
 * database is shared with the other specs.
 *
 *   P-05  a resident reports their own key lost (no button while off; with it on, the key turns Lost and only staff can resolve it)
 *   P-03  the "Out of hours" badge and desk filter; with the rule on Reception is refused (reason, owner, next action), the admin is not
 *   P-04  a damaged key needs a photo (the form says so and waits for the file)
 *   P-08  Mark as Left for a person who never had a site: the Accommodation Admin is blocked, a Super Admin is not
 *   P-07  on a clearance case, who may work an Accommodation Admin item
 *   P-06  a waived lost key: kept on the register (rule off) or written off (rule on)
 */
const PASSWORD = 'Welcome-GH-2026'
const PORT = Number(process.env.E2E_PORT ?? 3141)
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

function dbUrl(): string {
  if (process.env.E2E_DATABASE_URL) return process.env.E2E_DATABASE_URL
  throw new Error(`Set E2E_DATABASE_URL, or run through playwright's global setup on port ${PORT}`)
}
async function withDb<T>(fn: (db: Client) => Promise<T>): Promise<T> {
  const db = new Client({ connectionString: dbUrl() })
  await db.connect()
  try { return await fn(db) } finally { await db.end() }
}

/** Writes a new configuration version, exactly as the System configuration screen does (the table is append-only). */
async function setCfg(key: string, value: unknown, siteId?: string) {
  await withDb(db => db.query(
    `INSERT INTO config_item (key, scope_site_id, version, value)
     VALUES ($1, $2, COALESCE((SELECT max(version) FROM config_item WHERE key = $1 AND scope_site_id IS NOT DISTINCT FROM $2), 0) + 1, $3::jsonb)`,
    [key, siteId ?? null, JSON.stringify(value)]))
}
const DEFAULTS: Record<string, unknown> = {
  'keys.enforce_office_hours': false, 'keys.damage_evidence_required': false, 'keys.resident_may_report_lost': false,
  'clearance.waiver_writes_off_key': true, 'clearance.strict_item_owners': false, 'exit.sited_only': false,
}

interface Person { staffId: string; userId: string | null; employeeId: string; name: string }

async function arrange() {
  return withDb(async db => {
    const siteCode = `HM-${tag}`
    const site = (await db.query<{ id: string }>(`INSERT INTO site (code, name, kind) VALUES ($1, $2, 'apartment') RETURNING id`, [siteCode, `Hardening site ${tag}`])).rows[0].id
    const user = async (emp: string) => (await db.query<{ id: string }>(`SELECT u.id FROM user_account u JOIN staff_profile s ON s.id = u.staff_id WHERE s.employee_id = $1`, [emp])).rows[0].id
    for (const [emp, role] of [['E9001', 'AA'], ['E9002', 'Rec'], ['E9040', 'Mgr']] as const) {
      await db.query(`INSERT INTO role_assignment (user_id, role, scope_kind, site_id) VALUES ($1, $2, 'site', $3)`, [await user(emp), role, site])
    }
    const [mgr, maker, checker] = [await user('E9040'), await user('E9005'), await user('E9012')]
    if (!(await db.query(`SELECT 1 FROM capability_grant WHERE user_id = $1 AND capability = 'PolicyApprover' AND status = 'active'`, [mgr])).rowCount) {
      await db.query(
        `INSERT INTO capability_grant (user_id, capability, reason, starts_at, status, maker_id, checker_id, decided_at) VALUES ($1, 'PolicyApprover', 'e2e', now() - interval '1 day', 'active', $2, $3, now())`,
        [mgr, maker, checker])
    }
    const room = (await db.query<{ id: string }>(`INSERT INTO room (site_id, name) VALUES ($1, $2) RETURNING id`, [site, `HM-${tag}`])).rows[0].id
    const bed = async (n: number) => (await db.query<{ id: string }>(`INSERT INTO bed (site_id, room_id, code) VALUES ($1, $2, $3) RETURNING id`, [site, room, `HM-${tag}-${n}`])).rows[0].id
    const beds = [await bed(1), await bed(2), await bed(3)]
    const person = async (label: string, o: { bedId?: string; login?: boolean } = {}): Promise<Person> => {
      const employeeId = `E-HM-${tag}-${label}`
      const name = `Hardening ${label} ${tag}`
      const staffId = (await db.query<{ id: string }>(`INSERT INTO staff_profile (employee_id, full_name, source) VALUES ($1, $2, 'manual') RETURNING id`, [employeeId, name])).rows[0].id
      let userId: string | null = null
      if (o.login !== false) {
        userId = (await db.query<{ id: string }>(
          `INSERT INTO user_account (staff_id, username, password_hash, must_change_password, status) SELECT $1, $2, password_hash, false, 'active' FROM user_account WHERE username = 'E1007' RETURNING id`, [staffId, employeeId])).rows[0].id
        await db.query(`INSERT INTO role_assignment (user_id, role, scope_kind) VALUES ($1, 'Res', 'own')`, [userId])
      }
      if (o.bedId) {
        const claim = (await db.query<{ id: string }>(`INSERT INTO bed_claim (bed_id, kind, period) VALUES ($1, 'stay', '[2026-10-01,)') RETURNING id`, [o.bedId])).rows[0].id
        await db.query(`INSERT INTO stay (staff_id, bed_id, claim_id, status, stay_type, checked_in_at) VALUES ($1, $2, $3, 'active', 'permanent', '2026-10-01T10:00:00Z')`, [staffId, o.bedId, claim])
        await db.query(`UPDATE bed SET state = 'occupied' WHERE id = $1`, [o.bedId])
      }
      return { staffId, userId, employeeId, name }
    }
    const keeper = await person('KEEPER', { bedId: beds[0] })        // holds keys, reports one lost
    const leaverA = await person('LEAVERA', { bedId: beds[1] })      // left with a lost key: waiver with the rule off
    const leaverB = await person('LEAVERB', { bedId: beds[2] })      // left with a lost key: waiver with the rule on
    const nobody = await person('NOBODY', { login: false })          // never had a stay, reservation or request
    const nobody2 = await person('NOBODY2', { login: false })
    const key = async (code: string, o: { status?: string; holder?: string; roomId?: string; bedId?: string } = {}) =>
      (await db.query<{ id: string }>(
        `INSERT INTO handover_item (category, item_type, code, site_id, room_id, bed_id, status, holder_staff_id, issued_at) VALUES ('key', 'locker_key', $1, $2, $3, $4, $5, $6, CASE WHEN $6::uuid IS NOT NULL THEN now() END) RETURNING id`,
        [code, site, o.roomId ?? null, o.bedId ?? null, o.status ?? (o.holder ? 'issued' : 'in_cabinet'), o.holder ?? null])).rows[0].id
    const codes = {
      held: `HK${tag}A`, desk: `HK${tag}B`, damaged: `HK${tag}C`, lostA: `HK${tag}LA`, lostB: `HK${tag}LB`,
    }
    const ids = {
      held: await key(codes.held, { holder: keeper.staffId, bedId: beds[0] }),
      desk: await key(codes.desk, { bedId: beds[0] }),
      damaged: await key(codes.damaged, { bedId: beds[0] }),
      lostA: await key(codes.lostA, { holder: leaverA.staffId, bedId: beds[1], status: 'lost' }),
      lostB: await key(codes.lostB, { holder: leaverB.staffId, bedId: beds[2], status: 'lost' }),
    }
    return { site, siteCode, beds, keeper, leaverA, leaverB, nobody, nobody2, codes, ids }
  })
}

test.describe.serial('hardening WP-M: proposed key and clearance rules, each on and off', () => {
  let a: Awaited<ReturnType<typeof arrange>>
  const caseHref: Record<string, string> = {}
  test.beforeAll(async () => { a = await arrange() })
  test.afterAll(async () => {
    // whatever happened, every proposal goes back to its shipped default
    for (const [k, v] of Object.entries(DEFAULTS)) await setCfg(k, v)
    if (a?.site) await setCfg('keys.office_hours', { from: '08:00', to: '20:00' }, a.site)
  })

  test('P-05: no "Report lost" while the setting is off; with it on a resident reports their own key lost, and cannot resolve it', async ({ page }) => {
    await signIn(page, a.keeper.employeeId)
    await page.goto('/my')
    const list = page.getByRole('list', { name: 'Keys and assets I hold' })
    await expect(list.getByText(a.codes.held)).toBeVisible()
    await expect(page.getByRole('button', { name: /Report .* as lost/ })).toHaveCount(0)
    // the API says so clearly too (nothing changes)
    const refused = await page.request.post(`/api/v1/keys/${a.ids.held}/report-lost`, { data: { note: 'It fell in the sea' }, headers: { origin: `http://localhost:${PORT}` } })
    expect(refused.status()).toBe(403)
    expect(await refused.json()).toMatchObject({ owner: 'Reception', next: 'Tell Reception' })

    await setCfg('keys.resident_may_report_lost', true)
    await page.reload()
    await page.getByRole('button', { name: `Report ${a.codes.held} as lost` }).click()
    const dialog = page.getByRole('dialog')
    const submit = dialog.getByRole('button', { name: `Report ${a.codes.held} as lost` })
    await expect(submit).toBeDisabled()                         // the note is mandatory
    await dialog.getByLabel('What happened').fill('Dropped off the jetty')
    await submit.click()
    await expect(page.getByText(/reported lost\. Reception and the Accommodation Admin have been told/).first()).toBeVisible()
    await expect(list.locator('li', { hasText: a.codes.held })).toContainText('Lost')
    await expect(page.getByRole('button', { name: /Report .* as lost/ })).toHaveCount(0)
    // the resident has no way to mark it found or returned
    await page.goto(`/keys/${a.ids.held}`)
    await expect(page.getByRole('button', { name: /Mark found|Record return/ })).toHaveCount(0)
    await expect(page.getByText('Reported lost').first()).toBeVisible()
    await setCfg('keys.resident_may_report_lost', false)

    // Reception sees it and resolves it
    await signIn(page, 'E9002')
    await page.goto(`/keys/${a.ids.held}`)
    await expect(page.getByText('Reported lost').first()).toBeVisible()
    await expect(page.getByText('Dropped off the jetty').first()).toBeVisible()
    await expect(page.getByRole('button', { name: 'Mark found' })).toBeVisible()
    await page.getByRole('button', { name: 'Mark found' }).click()
    await page.getByRole('button', { name: new RegExp(`^Mark ${a.codes.held} as found`) }).click()
    await expect(page.getByText(/found and back with the holder/).first()).toBeVisible()
  })

  test('P-03: the "Out of hours" badge and desk filter; with the rule on, Reception is refused with reason, owner and next action and the Accommodation Admin is not', async ({ page }) => {
    // a one-minute desk window at 03:00 site time: any normal test run is outside it
    await setCfg('keys.office_hours', { from: '03:00', to: '03:01' }, a.site)
    await page.setViewportSize({ width: 390, height: 844 })
    await signIn(page, 'E9002')
    await page.goto('/keys')
    await page.getByLabel('Key or asset code').fill(a.codes.desk)
    await page.getByRole('button', { name: 'Find', exact: true }).click()
    await page.getByLabel('Employee ID').fill(a.keeper.employeeId)
    await page.getByRole('button', { name: 'Find person' }).click()
    await page.getByRole('button', { name: new RegExp(`^Issue ${a.codes.desk}`) }).click()
    await expect(page.getByText(/issued to Hardening KEEPER/).first()).toBeVisible()       // the rule is off: only flagged
    await page.goto(`/keys?q=${a.codes.desk}&show=all`)
    await page.getByRole('link', { name: new RegExp(a.codes.desk) }).first().click()
    await expect(page.getByText('Out of hours').first()).toBeVisible()                      // in the item history
    await page.goto('/keys?show=afterhours')
    await expect(page.getByRole('link', { name: a.codes.desk })).toBeVisible()              // in the desk list filter

    await setCfg('keys.enforce_office_hours', true)
    await page.goto('/keys')
    await page.getByLabel('Key or asset code').fill(a.codes.desk)
    await page.getByRole('button', { name: 'Find', exact: true }).click()
    await page.getByRole('button', { name: new RegExp(`Record the return of ${a.codes.desk}`) }).click()
    await expect(page.getByText(/The key desk is closed/).first()).toBeVisible()
    await expect(page.getByText(/Owner: Security/).first()).toBeVisible()
    await expect(page.getByText(/Next: .*Night Keys/).first()).toBeVisible()

    await signIn(page, 'E9001')                                                              // an Accommodation Admin is always allowed
    await page.goto('/keys')
    await page.getByLabel('Key or asset code').fill(a.codes.desk)
    await page.getByRole('button', { name: 'Find', exact: true }).click()
    await page.getByRole('button', { name: new RegExp(`Record the return of ${a.codes.desk}`) }).click()
    await expect(page.getByText(/returned/).first()).toBeVisible()
    await setCfg('keys.enforce_office_hours', false)
    await setCfg('keys.office_hours', { from: '08:00', to: '20:00' }, a.site)
  })

  test('P-04: while off a damaged key needs no photo; with it on the form asks for one and waits for it', async ({ page }) => {
    await signIn(page, 'E9002')
    await page.goto(`/keys/${a.ids.damaged}`)
    await page.getByRole('button', { name: 'Report damaged' }).click()
    await page.getByLabel('What is damaged').fill('Bent in the lock')
    const submit = page.getByRole('button', { name: new RegExp(`Record ${a.codes.damaged} as damaged`) })
    await expect(submit).toBeEnabled()                                    // off: the photo is optional, as before
    await expect(page.getByText(/Required: at least one photo or file/)).toHaveCount(0)
    await setCfg('keys.damage_evidence_required', true)
    await page.goto(`/keys/${a.ids.damaged}`)
    await page.getByRole('button', { name: 'Report damaged' }).click()
    await page.getByLabel('What is damaged').fill('Bent in the lock')
    await expect(page.getByText(/Required: at least one photo or file/)).toBeVisible()
    await expect(submit).toBeDisabled()
    await page.locator('input[type=file]').setInputFiles({ name: 'bent.png', mimeType: 'image/png', buffer: PNG })
    await expect(submit).toBeEnabled()
    await submit.click()
    await expect(page.getByText(/recorded as damaged/).first()).toBeVisible()
    await setCfg('keys.damage_evidence_required', false)
  })

  test('P-08: a person who never had a stay, reservation or request: blocked for the Accommodation Admin, allowed for a Super Admin; off by default', async ({ page }) => {
    await signIn(page, 'E9001')
    await page.goto(`/exits/new?employeeId=${encodeURIComponent(a.nobody.employeeId)}`)
    await expect(page.getByTestId('exit-preview')).toContainText('They have no stay')
    await expect(page.getByRole('button', { name: `Mark ${a.nobody.name} as Left` })).toBeVisible()      // off: any holder of the action

    await setCfg('exit.sited_only', true)
    await page.goto(`/exits/new?employeeId=${encodeURIComponent(a.nobody.employeeId)}`)
    const preview = page.getByTestId('exit-preview')
    await expect(preview).toContainText(/never had a stay, reservation or request/)
    await expect(preview).toContainText('Owner: Super Admin')
    await expect(page.getByRole('button', { name: `Mark ${a.nobody.name} as Left` })).toHaveCount(0)
    // bulk: the row is shown as blocked
    await page.goto('/exits/bulk')
    await page.getByLabel('Employee IDs').fill(a.nobody2.employeeId)
    await page.getByLabel('Reason').fill('Never arrived')
    await page.getByRole('button', { name: 'Preview' }).click()
    const row = page.locator(`li[data-row="${a.nobody2.employeeId}"]`)
    await expect(row).toHaveAttribute('data-outcome', 'blocked')
    await expect(row).toContainText('only a Super Admin')

    await signIn(page, 'E9005')                                                                        // the Super Admin can
    await page.goto(`/exits/new?employeeId=${encodeURIComponent(a.nobody.employeeId)}`)
    await page.getByLabel('Reason').fill('Never arrived')
    await page.getByLabel('Your password').fill(PASSWORD)
    await page.getByRole('button', { name: `Mark ${a.nobody.name} as Left` }).click()
    await expect(page.getByTestId('mark-left-done')).toContainText('The login has ended')
    await setCfg('exit.sited_only', false)
  })

  test('P-07: with the owner rule on, Reception is told an Accommodation Admin item is not theirs; the Accommodation Admin can complete it', async ({ page }) => {
    await signIn(page, 'E9001')
    for (const [k, p] of [['A', a.leaverA], ['B', a.leaverB]] as const) {
      await page.goto(`/exits/new?employeeId=${encodeURIComponent(p.employeeId)}`)
      await page.getByLabel('Reason').fill('Resigned, last day today')
      await page.getByLabel('Your password').fill(PASSWORD)
      await page.getByRole('button', { name: `Mark ${p.name} as Left` }).click()
      await expect(page.getByTestId('mark-left-done')).toContainText('The login has ended')
      caseHref[k] = (await page.getByRole('link', { name: 'Open the clearance case' }).getAttribute('href'))!
    }
    const aaItem = (page: Page) => page.getByTestId('clearance-items').locator('li', { hasText: 'Incident and loss record reviewed' })

    await signIn(page, 'E9002')                                                                        // off: Reception may complete it, as today
    await page.goto(caseHref.A)
    await expect(aaItem(page).getByRole('button', { name: /Mark done: Incident and loss record/ })).toBeVisible()
    await expect(page.getByText('Items are completed by their owner')).toHaveCount(0)

    await setCfg('clearance.strict_item_owners', true)
    await page.reload()
    await expect(page.getByText('Items are completed by their owner')).toBeVisible()
    await expect(aaItem(page).getByRole('button', { name: /Mark done: Incident and loss record/ })).toHaveCount(0)
    await expect(aaItem(page)).toContainText('belongs to the Accommodation Admin')
    await expect(aaItem(page)).toContainText('Owner: Accommodation Admin')
    await expect(page.getByTestId('clearance-items').locator('li', { hasText: 'Belongings removed from the room' }).getByRole('button', { name: /Mark done: Belongings/ })).toBeVisible()

    await signIn(page, 'E9001')
    await page.goto(caseHref.A)
    await aaItem(page).getByRole('button', { name: /Mark done: Incident and loss record/ }).click()
    await page.getByLabel('Note').fill('Reviewed with security')
    await page.getByRole('button', { name: 'Record as done' }).click()
    await expect(aaItem(page)).toContainText('Done')
    await setCfg('clearance.strict_item_owners', false)
  })

  test('P-06: a waived lost key is kept on the register with the rule off (the case says so), and written off with it on', async ({ page }) => {
    const waive = async (href: string, code: string) => {
      await signIn(page, 'E9040')
      await page.goto(href)
      const key = page.getByTestId('clearance-items').locator('li', { hasText: `Bed locker key ${code}` })
      await key.getByRole('button', { name: /Waive: Bed locker key/ }).click()
      const dialog = page.getByRole('dialog')
      await dialog.getByLabel('Reason for the waiver').fill('Lost on site; the lock was changed')
      await dialog.getByLabel('Evidence', { exact: true }).fill(`Incident report ${tag}`)
      await dialog.getByLabel('Your password').fill(PASSWORD)
      await dialog.getByRole('button', { name: 'Waive this item' }).click()
      await expect(key).toContainText('Waived')
      return key
    }

    // OFF: the waiver is recorded, the key stays Lost, and the case screen says what happens next
    await setCfg('clearance.waiver_writes_off_key', false)
    const keyA = await waive(caseHref.A, a.codes.lostA)
    await expect(page.getByText('A waiver does not write a key off')).toBeVisible()
    await expect(keyA.getByTestId('waived-key-open')).toContainText(`${a.codes.lostA} is still lost in the keys register`)
    await expect(keyA.getByTestId('waived-key-open')).toContainText('Owner: Accommodation Admin')
    await expect(keyA.getByTestId('waived-key-open')).toContainText(/Retire or replace .* in Keys & assets/)
    await withDb(async db => expect((await db.query(`SELECT status FROM handover_item WHERE id = $1`, [a.ids.lostA])).rows[0].status).toBe('lost'))
    // Keys & assets resolves it
    await signIn(page, 'E9001')
    await page.goto(`/keys/${a.ids.lostA}`)
    await page.getByRole('button', { name: 'Retire' }).click()
    await page.getByLabel('Reason').fill('Written off after the waiver')
    await page.getByRole('button', { name: new RegExp(`^Retire ${a.codes.lostA}`) }).click()
    await expect(page.getByText(/retired/).first()).toBeVisible()
    await withDb(async db => expect((await db.query(`SELECT status FROM handover_item WHERE id = $1`, [a.ids.lostA])).rows[0].status).toBe('retired'))

    // ON (the default): the waiver writes the key off
    await setCfg('clearance.waiver_writes_off_key', true)
    const keyB = await waive(caseHref.B, a.codes.lostB)
    await expect(keyB.getByTestId('waived-key-open')).toHaveCount(0)
    await withDb(async db => {
      expect((await db.query(`SELECT status, holder_staff_id FROM handover_item WHERE id = $1`, [a.ids.lostB])).rows[0]).toMatchObject({ status: 'retired', holder_staff_id: null })
      expect((await db.query(`SELECT kind, on_behalf FROM handover_event WHERE item_id = $1 ORDER BY created_at DESC LIMIT 1`, [a.ids.lostB])).rows[0]).toMatchObject({ kind: 'retired', on_behalf: true })
    })
  })
})
