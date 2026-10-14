import { readFile } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'

const PASSWORD = 'Welcome-GH-2026'

async function signIn(page: Page, username: string) {
  await page.goto('/login')
  await page.getByLabel('Username').fill(username)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { name: /Welcome/ })).toBeVisible()
}

test('Super Admin adds a staff member, a duplicate is refused, and a CSV import with a bad row hands back the rejected file', async ({ page }) => {
  await signIn(page, 'E9005')

  // add a staff member by hand
  await page.getByRole('button', { name: 'Staff', exact: true }).first().click()
  await expect(page.getByRole('heading', { name: 'Staff directory' })).toBeVisible()
  await page.getByRole('link', { name: 'Add staff' }).click()
  await page.getByLabel('Employee ID').fill('E7001')
  await page.getByLabel('Full name').fill('Maya Lopez')
  await page.getByLabel('Department').fill('Spa')
  await page.getByRole('button', { name: 'Add staff member' }).click()
  await expect(page.getByRole('heading', { name: 'Staff profile' })).toBeVisible()
  await expect(page.getByText('Maya Lopez').first()).toBeVisible()

  // the same employee ID again (different case) is refused and nothing is created
  await page.goto('/staff/new')
  await page.getByLabel('Employee ID').fill('e7001')
  await page.getByLabel('Full name').fill('Someone Else')
  await page.getByRole('button', { name: 'Add staff member' }).click()
  await expect(page.getByRole('alert').getByText(/Employee ID E7001 already exists \(Maya Lopez\)/)).toBeVisible()
  await expect(page.getByText('Already in use')).toBeVisible()
  await page.goto('/staff?q=E7001')
  await expect(page.getByRole('row', { name: /E7001/ })).toHaveCount(1)

  // CSV import: one good row, one duplicate of the person just added, one bad date
  await page.goto('/staff/import')
  const csv = [
    'employee_id,full_name,gender,department,grade,phone,email,joining_date,employment_status,emergency_contact_name,emergency_contact_phone',
    'E7101,Hassan Ali,Male,Culinary,2,+971501110001,,2026-10-12,Active,Amina Ali,+971501110099',
    'E7001,Duplicate Maya,Female,Spa,1,,,2026-10-12,Active,,',
    'E7103,Bad Date,Male,Laundry,1,,,12/13/2026,Active,,',
  ].join('\n')
  await page.getByLabel('Or paste the CSV text').fill(csv)
  await page.getByRole('button', { name: 'Preview' }).click()
  await expect(page.getByText('Nothing has been saved.')).toBeVisible()
  await expect(page.getByRole('row', { name: /New.*E7101/ })).toBeVisible()
  await expect(page.getByRole('row', { name: /Duplicate.*E7001.*already exists in the directory/ })).toBeVisible()
  await expect(page.getByRole('row', { name: /Invalid.*E7103.*Joining date/ })).toBeVisible()

  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByRole('heading', { name: '3. Confirm' })).toBeVisible()
  await page.getByRole('button', { name: 'Save 1 staff' }).click()

  // result: 1 saved + 2 rejected = 3, with the rejected file
  await expect(page.getByText('1 saved + 2 rejected = 3 rows')).toBeVisible()
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('link', { name: 'Download rejected rows' }).click(),
  ])
  expect(download.suggestedFilename()).toMatch(/^rejected-rows-.*\.csv$/)
  const text = await readFile((await download.path())!, 'utf8')
  expect(text).toContain('reason')
  expect(text).toContain('E7001')
  expect(text).toContain('E7103')
  expect(text).not.toContain('E7101')

  // the imported person is in the directory
  await page.goto('/staff?q=Hassan')
  await expect(page.getByRole('row', { name: /E7101/ })).toBeVisible()
})

test('Reception sees the minimum, a resident sees only their own record', async ({ page }) => {
  await signIn(page, 'E9002')
  await page.goto('/staff')
  await expect(page.getByText('Type at least 2 characters')).toBeVisible()
  await page.locator('input[name="q"]').fill('Rahul')
  await page.getByRole('button', { name: 'Search' }).click()
  await expect(page.getByRole('row', { name: /E1007/ })).toBeVisible()
  await expect(page.getByRole('columnheader', { name: 'Phone' })).toHaveCount(0)
  await page.goto('/staff/import')
  await expect(page.getByText('This page could not be found')).toBeVisible()

  await page.getByRole('button', { name: 'Sign out' }).first().click()
  await signIn(page, 'E1007')
  await page.goto('/staff')
  await expect(page).toHaveURL(/\/staff\/me$/)
  await expect(page.getByRole('heading', { name: 'My profile' })).toBeVisible()
  await expect(page.getByText('Rahul Menon').first()).toBeVisible()
})
