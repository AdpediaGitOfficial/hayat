import { randomBytes } from 'node:crypto'
import { expect, test, type Page } from '@playwright/test'
import { Client } from 'pg'
import { hashPassword } from '../../src/server/auth/password'

/**
 * WP-N hardening smoke (run with E2E_PORT=3142). Three proposals that are "proposed, pending client sign-off" are switched on FOR THE
 * DURATION of a test in this run's own database and put back afterwards (the specs of one run share a database and run one after the other).
 *
 *  1. P-09 + P-11: Reception raises a swap across two sites and finds the other resident by EMPLOYEE ID (an unknown ID gets the same answer
 *     as anyone who is not an active resident); the two Accommodation Admins approve, Reception carries it out. Reception never approves.
 *  2. P-10: a male resident asks to move into a site of female-only rooms. The destination admin chooses the bed and asks for an exception;
 *     the card says "waiting for a Policy Approver exception"; the Policy Approver finds it in the inbox and records it with reason,
 *     evidence and their password; the admin approves; Reception moves the resident; the use is recorded.
 *  3. P-14 and P-13: a bed with no cleaning record gets a task opened by hand and is inspected by someone else; the picker lists the
 *     housekeeper who works at the site first; an offer on a bed that is not ready is shown with the reason instead of being offered.
 * Every person, site, room and bed here is created by this spec.
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

/** This run's own database (the owner connection), once a site of this spec exists in it. */
async function withE2eDb<T>(siteCode: string, fn: (db: Client) => Promise<T>): Promise<T> {
  if (process.env.E2E_DATABASE_URL) {
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

async function setting(db: Client, key: string, value: unknown) {
  await db.query(
    `INSERT INTO config_item (key, scope_site_id, version, value) VALUES ($1, NULL, COALESCE((SELECT max(version) FROM config_item WHERE key = $1 AND scope_site_id IS NULL), 0) + 1, $2::jsonb)`,
    [key, JSON.stringify(value)])
}

interface Who { userId: string; staffId: string }
async function person(db: Client, hash: string, o: { username: string; name: string; role: 'Res' | 'AA' | 'Rec' | 'Mgr'; siteId?: string; gender?: 'male' | 'female'; grade?: number; employeeId?: string; caps?: string[] }): Promise<Who> {
  const s = (await db.query<{ id: string }>(`INSERT INTO staff_profile (employee_id, full_name, gender, grade) VALUES ($1, $2, $3, $4) RETURNING id`, [o.employeeId ?? o.username, o.name, o.gender ?? 'male', o.grade ?? 5])).rows[0].id
  const u = (await db.query<{ id: string }>(`INSERT INTO user_account (staff_id, username, password_hash, must_change_password, status) VALUES ($1, $2, $3, false, 'active') RETURNING id`, [s, o.username, hash])).rows[0].id
  await db.query(`INSERT INTO role_assignment (user_id, role, scope_kind, site_id) VALUES ($1, $2, $3, $4)`, [u, o.role, o.siteId ? 'site' : o.role === 'Res' ? 'own' : 'job', o.siteId ?? null])
  if (o.caps?.length) {
    const sas = (await db.query<{ id: string }>(`SELECT id FROM user_account WHERE username IN ('E9005', 'E9012') ORDER BY username`)).rows
    for (const cap of o.caps) {
      await db.query(
        `INSERT INTO capability_grant (user_id, capability, reason, starts_at, status, maker_id, checker_id, decided_at) VALUES ($1, $2, 'e2e', now() - interval '1 day', 'active', $3, $4, now())`,
        [u, cap, sas[0].id, sas[1].id])
    }
  }
  return { userId: u, staffId: s }
}
const stayFor = async (db: Client, staffId: string, bedId: string, from: number, to: number) => {
  const claim = (await db.query<{ id: string }>(`INSERT INTO bed_claim (bed_id, kind, period) VALUES ($1, 'stay', $2::daterange) RETURNING id`, [bedId, `[${iso(from)},${iso(to)})`])).rows[0].id
  const stay = (await db.query<{ id: string }>(`INSERT INTO stay (staff_id, bed_id, claim_id, status, stay_type, checked_in_at) VALUES ($1, $2, $3, 'active', 'contract', now() - interval '5 days') RETURNING id`, [staffId, bedId, claim])).rows[0].id
  await db.query(`UPDATE bed SET state = 'occupied' WHERE id = $1`, [bedId])
  return stay
}
const siteWith = async (db: Client, code: string, name: string, rooms: { name: string; gender: 'any' | 'female'; beds: string[] }[]) => {
  const siteId = (await db.query<{ id: string }>(`INSERT INTO site (code, name, kind) VALUES ($1, $2, 'apartment') RETURNING id`, [code, name])).rows[0].id
  const beds: Record<string, string> = {}
  for (const r of rooms) {
    const roomId = (await db.query<{ id: string }>(`INSERT INTO room (site_id, name, gender_policy) VALUES ($1, $2, $3) RETURNING id`, [siteId, r.name, r.gender])).rows[0].id
    for (const b of r.beds) beds[b] = (await db.query<{ id: string }>(`INSERT INTO bed (site_id, room_id, code) VALUES ($1, $2, $3) RETURNING id`, [siteId, roomId, b])).rows[0].id
  }
  return { siteId, beds }
}

/* ============================================================== 1. P-09 + P-11 ============================================================== */

test('Reception raises a swap across two sites and finds the other resident by employee ID; both sites approve; Reception never approves', async ({ page }) => {
  test.setTimeout(300_000)
  const tag = randomBytes(3).toString('hex').toUpperCase()
  const srcCode = `HS-${tag}`, dstCode = `HD-${tag}`, srcName = `Swap Source ${tag}`, dstName = `Swap Destination ${tag}`
  const hash = await hashPassword(PASSWORD)
  const u = (k: string) => `hn1${k}${tag}`.toLowerCase()
  const names = { a: `Alma Resident ${tag}`, b: `Boris Resident ${tag}`, rec: `Rita Reception ${tag}` }

  await signIn(page, 'E9005')
  expect((await page.request.post('/api/v1/property/sites', { data: { code: srcCode, name: srcName, kind: 'apartment' } })).ok()).toBeTruthy()
  const ids = await withE2eDb(srcCode, async db => {
    const src = (await db.query<{ id: string }>(`SELECT id FROM site WHERE code = $1`, [srcCode])).rows[0].id
    await db.query(`UPDATE site SET name = $2 WHERE id = $1`, [src, srcName])
    const room = (await db.query<{ id: string }>(`INSERT INTO room (site_id, name) VALUES ($1, $2) RETURNING id`, [src, `Src room ${tag}`])).rows[0].id
    const bedA = (await db.query<{ id: string }>(`INSERT INTO bed (site_id, room_id, code) VALUES ($1, $2, $3) RETURNING id`, [src, room, `${tag}-SA`])).rows[0].id
    const dst = await siteWith(db, dstCode, dstName, [{ name: `Dst room ${tag}`, gender: 'any', beds: [`${tag}-DB`] }])
    const a = await person(db, hash, { username: u('a'), name: names.a, role: 'Res', employeeId: `HA${tag}` })
    const b = await person(db, hash, { username: u('b'), name: names.b, role: 'Res', employeeId: `HB${tag}` })
    await person(db, hash, { username: u('rec'), name: names.rec, role: 'Rec', siteId: src })
    await person(db, hash, { username: u('aa1b'), name: `Anna Admin ${tag}`, role: 'AA', siteId: src })
    await person(db, hash, { username: u('aa2'), name: `Dmitri Admin ${tag}`, role: 'AA', siteId: dst.siteId })
    await person(db, hash, { username: u('recdst'), name: `Dora Reception ${tag}`, role: 'Rec', siteId: dst.siteId })
    const stayA = await stayFor(db, a.staffId, bedA, -5, 40)
    const stayB = await stayFor(db, b.staffId, dst.beds[`${tag}-DB`], -3, 50)
    await setting(db, 'transfers.reception_may_raise', true)
    await setting(db, 'transfers.swap_partner_lookup', true)
    return { src, dst: dst.siteId, bedA, bedB: dst.beds[`${tag}-DB`], stayA, stayB, a, b }
  })

  try {
    /* ---- Reception of the first site raises it and finds Boris by employee ID ---- */
    await signIn(page, u('rec'))
    await page.goto('/stays/transfers')
    const form = page.locator('section', { hasText: 'Propose a bed swap' })
    await form.getByLabel('First resident', { exact: true }).selectOption({ label: `${names.a} · ${srcName} › Src room ${tag} › Bed ${tag}-SA` })
    await form.getByLabel(/find them by employee ID/).check()
    await form.getByLabel("Second resident's employee ID").fill(`NOPE-${tag}`)
    await form.getByRole('button', { name: 'Check' }).click()
    await expect(page.getByTestId('partner-missing')).toContainText('No active stay was found for that employee ID')
    await form.getByLabel("Second resident's employee ID").fill(`hb${tag}`.toLowerCase())
    await form.getByRole('button', { name: 'Check' }).click()
    await expect(page.getByTestId('partner-found')).toContainText(names.b)
    await expect(page.getByTestId('partner-found')).toContainText(dstName)
    // only the name and the site: nothing of the person's employee ID or bed is on the screen
    await expect(page.getByTestId('partner-found')).not.toContainText(`HB${tag}`)
    await form.getByLabel(new RegExp(`Has ${names.a}.* agreed`)).selectOption('in_person')
    await form.getByLabel(/Has .*Boris.* agreed/).selectOption('in_person')
    await form.getByLabel('Reason').fill('Friends want to swap sites')
    await form.getByRole('button', { name: 'Propose swap' }).click()
    await expect(page.getByText(/Swap requested/).first()).toBeVisible()

    const card = () => page.locator('section', { hasText: `Swap: ${names.a} and ${names.b}` })
    await expect(card()).toContainText('Between sites')
    await expect(card()).toContainText('Raised for the resident by')
    await expect(card().getByRole('button', { name: /Approve/ })).toHaveCount(0) // Reception never approves what it raised, or anything

    /* ---- the Accommodation Admin of the same site (not the raiser) approves their side; the other site approves theirs ---- */
    await signIn(page, u('aa1b'))
    await page.goto('/stays/transfers')
    await card().getByRole('button', { name: new RegExp(`Approve: let them leave ${srcName}`) }).click()
    await expect(page.getByText('Your approval is recorded').first()).toBeVisible()
    await signIn(page, u('aa2'))
    await page.goto('/stays/transfers')
    await card().getByRole('button', { name: new RegExp(`Approve: take them into ${dstName}`) }).click()
    await expect(page.getByText(/approved by both sites/).first()).toBeVisible()

    /* ---- Reception of the destination carries it out ---- */
    await signIn(page, u('recdst'))
    await page.goto('/stays/transfers')
    await card().getByRole('button', { name: /Carry out swap now/ }).click()
    await expect(page.getByText(/^Swapped:/).first()).toBeVisible()
    await withE2eDb(srcCode, async db => {
      expect((await db.query(`SELECT bed_id FROM stay WHERE id = $1`, [ids.stayA])).rows[0].bed_id).toBe(ids.bedB)
      expect((await db.query(`SELECT bed_id FROM stay WHERE id = $1`, [ids.stayB])).rows[0].bed_id).toBe(ids.bedA)
      const audit = (await db.query(`SELECT actor_role, after FROM audit_event WHERE action = 'stays.swap.requested' AND entity_id = (SELECT id FROM transfer_request WHERE stay_id = $1)`, [ids.stayA])).rows[0]
      expect(audit.actor_role).toBe('Rec')
      expect(audit.after.raisedByRole).toBe('Rec')
      expect(audit.after.partnerNamedByEmployeeId).toBe(true)
    })
  } finally {
    await withE2eDb(srcCode, async db => { await setting(db, 'transfers.reception_may_raise', false); await setting(db, 'transfers.swap_partner_lookup', false) })
  }
})

/* ============================================================== 2. P-10 ============================================================== */

test('a transfer into a site whose rooms the resident may not have: asked for an exception, recorded by a Policy Approver with evidence and password, approved, carried out, the use recorded', async ({ page }) => {
  test.setTimeout(300_000)
  const tag = randomBytes(3).toString('hex').toUpperCase()
  const srcCode = `XS-${tag}`, dstCode = `XD-${tag}`, srcName = `Exception Source ${tag}`, dstName = `Exception Destination ${tag}`
  const hash = await hashPassword(PASSWORD)
  const u = (k: string) => `hn2${k}${tag}`.toLowerCase()
  const resName = `Marco Resident ${tag}`

  await signIn(page, 'E9005')
  expect((await page.request.post('/api/v1/property/sites', { data: { code: srcCode, name: srcName, kind: 'apartment' } })).ok()).toBeTruthy()
  const ids = await withE2eDb(srcCode, async db => {
    const src = (await db.query<{ id: string }>(`SELECT id FROM site WHERE code = $1`, [srcCode])).rows[0].id
    await db.query(`UPDATE site SET name = $2 WHERE id = $1`, [src, srcName])
    const room = (await db.query<{ id: string }>(`INSERT INTO room (site_id, name) VALUES ($1, $2) RETURNING id`, [src, `Src room ${tag}`])).rows[0].id
    const bedA = (await db.query<{ id: string }>(`INSERT INTO bed (site_id, room_id, code) VALUES ($1, $2, $3) RETURNING id`, [src, room, `${tag}-A`])).rows[0].id
    const dst = await siteWith(db, dstCode, dstName, [{ name: `Women only ${tag}`, gender: 'female', beds: [`${tag}-W1`, `${tag}-W2`] }])
    const res = await person(db, hash, { username: u('res'), name: resName, role: 'Res', gender: 'male' })
    await person(db, hash, { username: u('aa1'), name: `Sam Admin ${tag}`, role: 'AA', siteId: src })
    await person(db, hash, { username: u('aa2'), name: `Dana Admin ${tag}`, role: 'AA', siteId: dst.siteId })
    await person(db, hash, { username: u('rec2'), name: `Remy Reception ${tag}`, role: 'Rec', siteId: dst.siteId })
    await person(db, hash, { username: u('pa'), name: `Paula Approver ${tag}`, role: 'Mgr', siteId: dst.siteId, caps: ['PolicyApprover'] })
    const stay = await stayFor(db, res.staffId, bedA, -5, 40)
    return { src, dst: dst.siteId, bedA, w1: dst.beds[`${tag}-W1`], stay, res }
  })
  const card = () => page.locator('section', { hasText: `Move: ${resName}` })

  /* ---- the resident asks to move into the other site: any suitable bed (the women-only beds are listed as not available to them) ---- */
  await signIn(page, u('res'))
  await page.goto('/my')
  await page.getByLabel('Move to').selectOption({ label: dstName })
  await expect(page.getByRole('list', { name: 'Beds that are not available to you' })).toContainText('female-only')
  await page.getByLabel('Reason').last().fill('Joining the project in the other site')
  await page.getByRole('button', { name: 'Request move' }).click()
  await expect(page.getByRole('heading', { name: `Move to ${dstName} requested` })).toBeVisible()

  /* ---- the source site lets them go ---- */
  await signIn(page, u('aa1'))
  await page.goto('/stays/transfers')
  await card().getByRole('button', { name: `Approve: let them leave ${srcName}` }).click()
  await expect(page.getByText('Your approval is recorded').first()).toBeVisible()

  /* ---- the destination admin chooses a bed that needs an exception and asks for it ---- */
  await signIn(page, u('aa2'))
  await page.goto('/stays/transfers')
  await expect(card().getByLabel('Destination bed')).toBeVisible()
  await card().getByLabel('Destination bed').selectOption({ label: `Women only ${tag} · ${tag}-W1` })
  await expect(card()).toContainText('This bed fails a rule of the site')
  await card().getByRole('button', { name: 'Ask a Policy Approver for an exception for this bed' }).click()
  await expect(page.getByText(/waits for a Policy Approver/).first()).toBeVisible()
  await expect(card()).toContainText('Waiting for a Policy Approver exception')
  await expect(card()).toContainText(`Owner: Policy Approver of ${dstName}`)
  await expect(card()).toContainText('Proposed policy, pending client sign-off')
  await expect(card().getByRole('button', { name: /Record an exception/ })).toHaveCount(0) // an admin is not a Policy Approver

  /* ---- the Policy Approver finds it in the inbox and records the exception ---- */
  await signIn(page, u('pa'))
  await page.goto('/approvals')
  await expect(page.getByText('Transfer exception (proposed policy)').first()).toBeVisible()
  await expect(page.getByText(/gender exception for a transfer/).first()).toBeVisible()
  await page.goto('/stays/transfers')
  // an approver with no access to the staff directory sees "Resident" on the card, but the exception says who it is about
  const paCard = page.locator('section', { hasText: `Bed ${tag}-W1` })
  await expect(paCard).toContainText(resName)
  await paCard.getByRole('button', { name: /Record an exception/ }).click()
  await paCard.getByLabel('Reason').fill('Needed on site for the project')
  await paCard.getByLabel('Evidence').fill('HR memo of 12 October')
  await expect(paCard.getByRole('button', { name: 'Record the exception' })).toBeDisabled() // no password yet
  await paCard.getByLabel('Confirm with your password').fill('wrong-password-1')
  await paCard.getByRole('button', { name: 'Record the exception' }).click()
  await expect(paCard).toContainText('That password is not right')
  await paCard.getByLabel('Confirm with your password').fill(PASSWORD)
  await paCard.getByRole('button', { name: 'Record the exception' }).click()
  await expect(page.getByText(/Exception recorded for this move only/).first()).toBeVisible()

  /* ---- the destination admin approves, Reception carries it out ---- */
  await signIn(page, u('aa2'))
  await page.goto('/stays/transfers')
  await card().getByRole('button', { name: `Approve: take them into ${dstName}` }).click()
  await expect(page.getByText(/approved by both sites/).first()).toBeVisible()
  await signIn(page, u('rec2'))
  await page.goto('/stays/transfers')
  await card().getByRole('button', { name: /Carry out move now/ }).click()
  await expect(page.getByText(/^Moved to /).first()).toBeVisible()

  await withE2eDb(srcCode, async db => {
    expect((await db.query(`SELECT bed_id FROM stay WHERE id = $1`, [ids.stay])).rows[0].bed_id).toBe(ids.w1)
    const ex = (await db.query(`SELECT e.kind, e.evidence, e.reason, e.site_id, e.transfer_request_id, u.used_for FROM eligibility_exception e LEFT JOIN eligibility_exception_use u ON u.exception_id = e.id WHERE e.staff_id = $1`, [ids.res.staffId])).rows
    expect(ex).toHaveLength(1)
    expect(ex[0]).toMatchObject({ kind: 'gender', evidence: 'HR memo of 12 October', reason: 'Needed on site for the project', site_id: ids.dst, used_for: 'transfer' })
    expect(ex[0].transfer_request_id).not.toBeNull()
  })
})

/* ============================================================== 3. P-14 and P-13 ============================================================== */

test('a bed with no cleaning record: a task opened by hand, inspected by someone else; the picker lists the housekeeper of the site first; an offer on a bed that is not ready shows why not', async ({ page }) => {
  test.setTimeout(300_000)
  const tag = randomBytes(3).toString('hex').toUpperCase()
  const siteCode = `HR-${tag}`, siteName = `Readiness Hardening ${tag}`
  const hash = await hashPassword(PASSWORD)
  const u = (k: string) => `hn3${k}${tag}`.toLowerCase()
  const names = { hk1: `Aaron Housekeeper ${tag}`, hk2: `Zoe Housekeeper ${tag}`, waiting: `Wanda Waiting ${tag}` }

  await signIn(page, 'E9005')
  expect((await page.request.post('/api/v1/property/sites', { data: { code: siteCode, name: siteName, kind: 'apartment' } })).ok()).toBeTruthy()
  const ids = await withE2eDb(siteCode, async db => {
    const site = (await db.query<{ id: string }>(`SELECT id FROM site WHERE code = $1`, [siteCode])).rows[0].id
    const room = (await db.query<{ id: string }>(`INSERT INTO room (site_id, name) VALUES ($1, $2) RETURNING id`, [site, `Room ${tag}`])).rows[0].id
    const mk = async (code: string) => (await db.query<{ id: string }>(`INSERT INTO bed (site_id, room_id, code) VALUES ($1, $2, $3) RETURNING id`, [site, room, code])).rows[0].id
    const [bx, by, bz] = [await mk(`${tag}-X`), await mk(`${tag}-Y`), await mk(`${tag}-Z`)]
    // X waits for its inspection with no task; Y needs cleaning with no task; Z is Available (the person waits for a bed)
    await db.query(`UPDATE bed SET state = 'occupied' WHERE id = ANY($1::uuid[])`, [[bx, by]])
    await db.query(`UPDATE bed SET state = 'needs_cleaning' WHERE id = ANY($1::uuid[])`, [[bx, by]])
    await db.query(`UPDATE bed SET state = 'inspection_required' WHERE id = $1`, [bx])
    await person(db, hash, { username: u('rec'), name: `Rita Reception ${tag}`, role: 'Rec', siteId: site })
    await person(db, hash, { username: u('aa'), name: `Abel Admin ${tag}`, role: 'AA', siteId: site })
    await person(db, hash, { username: u('insp'), name: `Ivan Inspector ${tag}`, role: 'AA', siteId: site, caps: ['FinalInspection'] })
    const hk1 = await person(db, hash, { username: u('hk1'), name: names.hk1, role: 'Res', caps: ['Housekeeping'] })
    const hk2 = await person(db, hash, { username: u('hk2'), name: names.hk2, role: 'Res', caps: ['Housekeeping'] })
    // Zoe worked this site last week (a finished task); Aaron never did. By name Aaron would be first.
    await db.query(`INSERT INTO cleaning_task (bed_id, site_id, reason, status, assigned_to_staff, assigned_at) VALUES ($1, $2, 'earlier', 'passed', $3, now() - interval '7 days')`, [bz, site, hk2.staffId])
    const waiting = await person(db, hash, { username: u('wait'), name: names.waiting, role: 'Res' })
    await db.query(`INSERT INTO waitlist_entry (staff_id, site_id, expires_at, arrival_date, end_date, stay_type, status) VALUES ($1, $2, now() + interval '10 days', $3, $4, 'contract', 'waiting')`, [waiting.staffId, site, iso(0), iso(30)])
    return { site, bx, by, bz, hk1, hk2 }
  })
  const rowOf = (code: string) => page.locator('li', { hasText: `Bed ${tag}-${code}` })

  /* ---- Reception sees both beds with owner and next action, and opens a task by hand for each ---- */
  await signIn(page, u('rec'))
  await page.goto('/housekeeping')
  await expect(rowOf('X')).toContainText('No cleaned task is on record for this bed')
  await expect(rowOf('X')).toContainText('Owner: Reception')
  await rowOf('X').getByRole('button', { name: 'Open a task by hand…' }).click()
  const dlg = page.getByRole('dialog', { name: 'Open a cleaning task by hand' })
  await expect(dlg).toContainText('There is no cleaning record for this bed')
  await expect(dlg.getByRole('button', { name: 'Open for the final inspection' })).toBeDisabled() // a reason is mandatory
  await dlg.getByLabel('Why').fill('Seeded from the old spreadsheet, nobody cleaned it')
  await dlg.getByRole('button', { name: 'Open for the final inspection' }).click()
  await expect(page.getByText(/ready for the final inspection/).first()).toBeVisible()
  await expect(rowOf('X')).toContainText('awaiting final inspection')
  await expect(rowOf('X')).toContainText('Owner: Final Inspection holder')

  await rowOf('Y').getByRole('button', { name: 'Open a task by hand…' }).click()
  const dlgY = page.getByRole('dialog', { name: 'Open a cleaning task by hand' })
  await dlgY.getByLabel('Why').fill('Seeded as needing cleaning, no task exists')
  await dlgY.getByRole('button', { name: 'Open the task' }).click()
  await expect(page.getByText(/A cleaning task is open for bed/).first()).toBeVisible()

  /* ---- the picker: the housekeeper who works here comes first, although by name Aaron is first ---- */
  await rowOf('Y').getByRole('button', { name: 'Assign a housekeeper…' }).click()
  const pick = page.getByRole('dialog', { name: 'Assign a housekeeper' }).getByLabel('Housekeeper')
  await expect(pick.locator('option', { hasText: names.hk2 })).toHaveCount(1)
  const options = await pick.locator('option').allTextContents()
  const mine = options.filter(o => o.includes(tag))
  expect(mine[0]).toContain(names.hk2)
  expect(mine[0]).toContain('works here')
  expect(mine[1]).toContain(names.hk1)
  expect(mine[0]).toMatch(/\(hn3hk2/) // the employee ID is listed with the name
  await page.keyboard.press('Escape')

  /* ---- the Final Inspection holder sees "no cleaning record" and passes bed X; the one who opened it could not ---- */
  await signIn(page, u('insp'))
  await page.goto('/housekeeping')
  const queued = page.locator('li[data-task]', { hasText: `Bed ${tag}-X` })
  await expect(queued).toContainText('No cleaning record')
  await queued.getByRole('button', { name: 'Pass: bed is ready' }).click()
  await expect(page.getByText(/is now Available/).first()).toBeVisible()
  await withE2eDb(siteCode, async db => {
    const t = (await db.query(`SELECT status, cleaned_by_staff, inspected_by_staff, assigned_by FROM cleaning_task WHERE bed_id = $1 ORDER BY created_at DESC LIMIT 1`, [ids.bx])).rows[0]
    expect(t).toMatchObject({ status: 'passed', cleaned_by_staff: null })
    expect(t.inspected_by_staff).not.toBeNull()
    expect(t.assigned_by).not.toBeNull() // whoever opened it (Reception), not the inspector
    expect((await db.query(`SELECT state FROM bed WHERE id = $1`, [ids.bx])).rows[0].state).toBe('available')
  })

  /* ---- P-13: the waitlist shows a bed that is not ready WITH the reason, and does not offer it ---- */
  await signIn(page, u('aa'))
  await page.goto('/waitlist')
  await page.getByRole('button', { name: 'Offer a bed' }).first().click()
  const offer = page.getByRole('dialog', { name: new RegExp(`Offer a bed to ${names.waiting}`) })
  await expect(offer.getByTestId('offer-blocked-bed').first()).toContainText('cannot be offered from')
  await expect(offer.getByTestId('offer-blocked-bed').first()).toContainText('Owner:')
  await expect(offer.getByTestId('offer-blocked-bed').first()).toContainText('Next: Offer it for a later date')
  await expect(offer.getByTestId('offer-blocked-bed').first()).toContainText('proposed policy, pending client sign-off')
  await withE2eDb(siteCode, async db => {
    expect((await db.query(`SELECT 1 FROM bed_offer WHERE bed_id = ANY($1::uuid[])`, [[ids.bx, ids.by, ids.bz]])).rowCount).toBe(0)
  })
})
