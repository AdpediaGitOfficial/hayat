import { expect, test, type Page } from '@playwright/test'

const PASSWORD = 'Welcome-GH-2026'

async function signIn(page: Page, username: string, password = PASSWORD) {
  await page.goto('/login')
  await page.getByLabel('Username').fill(username)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()
}

test('a signed-out visitor is sent to the sign-in page', async ({ page }) => {
  await page.goto('/')
  await expect(page).toHaveURL(/\/login$/)
})

test('wrong password shows one generic message; the right one opens the dashboard', async ({ page }) => {
  await signIn(page, 'E9001', 'not-the-password')
  await expect(page.getByText('Wrong username or password')).toBeVisible()
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { name: /Welcome, Anita Rao/ })).toBeVisible()
  await expect(page.getByText('Accommodation Admin').first()).toBeVisible()
})

test('first sign-in forces a new password, then the session works', async ({ page }) => {
  await signIn(page, 'E1099')
  await expect(page).toHaveURL(/\/change-password$/)
  await page.goto('/')
  await expect(page).toHaveURL(/\/change-password$/)
  await page.getByLabel('Temporary password').fill(PASSWORD)
  await page.getByLabel('New password', { exact: true }).fill('A-brand-new-pass-7')
  await page.getByLabel('New password again').fill('A-brand-new-pass-7')
  await page.getByRole('button', { name: 'Save password' }).click()
  await expect(page.getByRole('heading', { name: /Welcome/ })).toBeVisible()
})

test('a user with two roles switches mode and the scope changes', async ({ page }) => {
  await signIn(page, 'E9060')
  await expect(page.getByText('1 assigned')).toBeVisible()
  await page.locator('.topbar button').last().click()
  await page.getByRole('menuitemradio', { name: /Resident/ }).click()
  await expect(page.getByText('No site scope')).toBeVisible()
})

test('sign out ends the session', async ({ page }) => {
  await signIn(page, 'E9005')
  await expect(page.getByRole('heading', { name: /Welcome/ })).toBeVisible()
  await page.getByRole('button', { name: 'Sign out' }).first().click()
  await expect(page).toHaveURL(/\/login$/)
  await page.goto('/')
  await expect(page).toHaveURL(/\/login$/)
})
