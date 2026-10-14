import { randomBytes } from 'node:crypto'
import { Client } from 'pg'
import type { TestProject } from 'vitest/node'
import { migrate } from '../../src/server/db/migrate'
import { withDatabase } from './url'

/**
 * One throwaway database per test run: gh_platform_test_<random>, migrated from the real SQL files and dropped
 * afterwards. Also creates a login role that is a member of app_role, so tests can connect AS the application.
 */
declare module 'vitest' {
  export interface ProvidedContext {
    /** Superuser connection to the freshly migrated test database. */
    dbUrl: string
    /** Login that only holds app_role's privileges (what the running app uses). */
    appDbUrl: string
    /** Superuser connection to the server's maintenance database (to create more throwaway databases). */
    adminUrl: string
  }
}

export const ADMIN_URL_DEFAULT = 'postgres://postgres@localhost:5432/postgres'

export default async function setup(project: TestProject) {
  const adminUrl = process.env.TEST_DATABASE_ADMIN_URL ?? ADMIN_URL_DEFAULT
  const suffix = randomBytes(5).toString('hex')
  const dbName = `gh_platform_test_${suffix}`
  const appLogin = `gh_app_login_${suffix}`
  const appPassword = randomBytes(12).toString('hex')

  const admin = new Client({ connectionString: adminUrl })
  try {
    await admin.connect()
  } catch (err) {
    throw new Error(
      `Cannot reach PostgreSQL at TEST_DATABASE_ADMIN_URL (${new URL(adminUrl).host}): ${(err as Error).message}. ` +
      'Tests run against a real server; see platform/README.md.',
    )
  }
  await admin.query(`CREATE DATABASE ${dbName}`)

  const dbUrl = withDatabase(adminUrl, dbName)
  await migrate(dbUrl)

  await admin.query(`CREATE ROLE ${appLogin} LOGIN PASSWORD '${appPassword}' IN ROLE app_role`)
  const appUrl = new URL(dbUrl)
  appUrl.username = appLogin
  appUrl.password = appPassword

  project.provide('dbUrl', dbUrl)
  project.provide('appDbUrl', appUrl.toString())
  project.provide('adminUrl', adminUrl)

  return async () => {
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`)
      await admin.query(`DROP ROLE IF EXISTS ${appLogin}`)
    } finally {
      await admin.end()
    }
  }
}
