import { migrate } from '../src/server/db/migrate'

try { process.loadEnvFile('.env') } catch { /* no .env: rely on the real environment */ }

const url = process.env.DATABASE_URL
if (!url) {
  console.error('DATABASE_URL is not set (see .env.example)')
  process.exit(1)
}

migrate(url, undefined, msg => console.log(msg))
  .then(r => console.log(`migrations: ${r.applied.length} applied, ${r.skipped.length} already up to date`))
  .catch(err => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
