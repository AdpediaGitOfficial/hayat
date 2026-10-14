/**
 * Runs the sweeps (timers: reminders, escalation, expiry of holds). Safe to run as often as you like.
 *   DATABASE_URL=… npm run sweeps            # once
 *   DATABASE_URL=… npm run sweeps -- --loop 60   # every 60 seconds
 * In production a scheduler may instead POST /api/v1/internal/sweeps with INTERNAL_JOB_TOKEN.
 */
import { runSweeps } from '../src/server/jobs/registry'
import '../src/server/jobs/sweeps'
import { systemClock } from '../src/server/clock'

try { process.loadEnvFile('.env') } catch { /* real environment only */ }
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set'); process.exit(1) }

const i = process.argv.indexOf('--loop')
const every = i > 0 ? Number(process.argv[i + 1]) : 0
async function once() {
  const out = await runSweeps(systemClock)
  console.log(JSON.stringify({ at: new Date().toISOString(), out }))
  return out.every(o => o.ok)
}
if (every > 0) {
  for (;;) { await once(); await new Promise(r => setTimeout(r, every * 1000)) }
} else {
  process.exit((await once()) ? 0 : 1)
}
