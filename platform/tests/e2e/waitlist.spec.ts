import { randomBytes } from 'node:crypto'
import { expect, test, type Page } from '@playwright/test'

/**
 * WP-E smoke (run with E2E_PORT=3125): an Accommodation Admin puts a resident on the waitlist and offers a bed; the resident opens the
 * offer (which starts the 48 hours), declines once (keeps the place), is offered another bed and accepts it. Reception can record
 * "informed offline"; the Accommodation Admin of another site sees none of it.
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
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10)

test('waitlist: add, offer a bed, first decline keeps the place, second offer is accepted', async ({ page }) => {
  const tag = randomBytes(3).toString('hex').toUpperCase()

  /* ---- the Accommodation Admin of Palm Villas and Marina prepares two beds ---- */
  await signIn(page, 'E9001')
  const sites = await (await page.request.get('/api/v1/property/sites')).json()
  const pv = sites.data.find((s: { code: string }) => s.code === 'PV')
  expect(pv).toBeTruthy()
  const room = await page.request.post('/api/v1/property/rooms', { data: { siteId: pv.id, name: `Wait-${tag}`, bedCodes: [`W${tag}-A`, `W${tag}-B`] } })
  expect(room.ok()).toBe(true)

  /* ---- adds a resident to the waitlist ---- */
  await page.getByRole('button', { name: 'Waitlist', exact: true }).first().click()
  await expect(page.getByRole('heading', { name: 'Waitlist', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Add to waitlist' }).click()
  const add = page.getByRole('dialog', { name: 'Add to the waitlist' })
  await add.getByLabel('Employee ID').fill('E1007')
  await add.getByLabel('Site').selectOption({ label: 'Palm Villas' })
  await add.getByLabel('Wanted from').fill(day(10))
  await add.getByLabel('Until (departure day)').fill(day(70))
  await add.getByRole('button', { name: 'Add to waitlist' }).click()
  const queue = page.getByTestId('queue-PV')
  const row = queue.getByRole('row', { name: /Rahul Menon/ })
  await expect(row).toBeVisible()
  await expect(row.getByText('Waiting')).toBeVisible()
  await expect(row.getByText(/left/)).toBeVisible() // the 15-day countdown
  // the same person cannot be added twice
  await page.getByRole('button', { name: 'Add to waitlist' }).click()
  const again = page.getByRole('dialog', { name: 'Add to the waitlist' })
  await again.getByLabel('Employee ID').fill('E1007')
  await again.getByLabel('Site').selectOption({ label: 'Palm Villas' })
  await again.getByLabel('Wanted from').fill(day(10))
  await again.getByRole('button', { name: 'Add to waitlist' }).click()
  await expect(again.getByRole('alert').getByText(/already on the waitlist/)).toBeVisible()
  await again.getByRole('button', { name: 'Cancel' }).click()

  /* ---- offers the first bed: it is held, and the 48 hours have not started ---- */
  await row.getByRole('button', { name: 'Offer a bed' }).click()
  const offer = page.getByRole('dialog', { name: /Offer a bed to Rahul Menon/ })
  await expect(offer.getByLabel('Bed to hold')).toBeVisible()
  await expect.poll(async () => offer.getByLabel('Bed to hold').locator('option').count()).toBeGreaterThan(1)
  const first = await offer.getByLabel('Bed to hold').locator('option').allTextContents()
  await offer.getByLabel('Bed to hold').selectOption({ index: first.findIndex(o => o.includes(`W${tag}-A`)) })
  await offer.getByRole('button', { name: 'Hold this bed' }).click()
  await expect(queue.getByRole('row', { name: /Rahul Menon/ }).getByText('Offered')).toBeVisible()
  await expect(queue.getByText('Offers in flight')).toBeVisible()
  await expect(queue.getByText('Not delivered')).toBeVisible()

  /* ---- the resident opens the offer (confirmed delivery) and declines once ---- */
  await signIn(page, 'E1007')
  await page.goto('/my')
  const mine = page.getByTestId('my-waitlist')
  await expect(mine.getByText('A bed is being held for you')).toBeVisible()
  await expect(mine.getByText(`W${tag}-A`).first()).toBeVisible()
  await expect(mine.getByText(/left/).first()).toBeVisible() // the 48-hour countdown
  await expect(mine.getByText(/first decline keeps your place/i)).toBeVisible()
  await mine.getByRole('button', { name: 'Decline', exact: true }).click()
  const decline = page.getByRole('dialog', { name: 'Decline this bed?' })
  await expect(decline.getByText(/This is your first decline: you keep your place/)).toBeVisible()
  await decline.getByRole('button', { name: 'Yes, decline' }).click()
  await expect(mine.getByText(`You declined bed W${tag}-A`)).toBeVisible()
  await expect(mine.getByText(/Number 1 of/)).toBeVisible()

  /* ---- the Accommodation Admin offers the other bed (the declined one is not offered again) ---- */
  await signIn(page, 'E9001')
  await page.goto('/waitlist')
  await page.getByTestId('queue-PV').getByRole('row', { name: /Rahul Menon/ }).getByRole('button', { name: 'Offer a bed' }).click()
  const second = page.getByRole('dialog', { name: /Offer a bed to Rahul Menon/ })
  await expect.poll(async () => second.getByLabel('Bed to hold').locator('option').count()).toBeGreaterThan(1)
  const options = await second.getByLabel('Bed to hold').locator('option').allTextContents()
  expect(options.some(o => o.includes(`W${tag}-A`))).toBe(false)
  expect(options.some(o => o.includes(`W${tag}-B`))).toBe(true)
  await second.getByLabel('Bed to hold').selectOption({ index: options.findIndex(o => o.includes(`W${tag}-B`)) })
  await second.getByRole('button', { name: 'Hold this bed' }).click()
  await expect(page.getByTestId('queue-PV').getByText('Offers in flight')).toBeVisible()

  /* ---- Reception can record "informed offline" (this one is already delivered when the resident opens it, so check the button exists first) ---- */
  await signIn(page, 'E9002')
  await page.goto('/waitlist')
  await expect(page.getByTestId('queue-PV').getByRole('button', { name: 'Record: informed offline' })).toBeVisible()
  await expect(page.getByTestId('queue-PV').getByRole('button', { name: 'Offer a bed' })).toHaveCount(0) // Reception cannot offer beds

  /* ---- the resident accepts ---- */
  await signIn(page, 'E1007')
  await page.goto('/my')
  const mine2 = page.getByTestId('my-waitlist')
  await expect(mine2.getByText('A bed is being held for you')).toBeVisible()
  await mine2.getByRole('button', { name: 'Accept this bed' }).click()
  await expect(mine2.getByText(`Bed W${tag}-B is reserved for you`)).toBeVisible()

  /* ---- the queue no longer lists them; the Accommodation Admin of Lakeview never saw any of it ---- */
  await signIn(page, 'E9001')
  await page.goto('/waitlist')
  await expect(page.getByTestId('queue-PV').getByRole('row', { name: /Rahul Menon/ })).toHaveCount(0)
  await signIn(page, 'E9011')
  await page.goto('/waitlist')
  await expect(page.getByTestId('queue-PV')).toHaveCount(0)
  await expect(page.getByTestId('queue-LV')).toBeVisible()
  await expect(page.getByText('Rahul Menon')).toHaveCount(0)
})
