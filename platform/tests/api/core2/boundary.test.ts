import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * STAGE-2 risk: four packages must not each invent their own way to create or change a bed claim.
 * Only src/server/allocation/claims.ts may write bed_claim; everything else goes through allocateBed() and the claims service.
 */
const ROOT = path.resolve(__dirname, '../../..')
function files(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = path.join(dir, f)
    if (statSync(p).isDirectory()) { if (!['node_modules', '.next', 'tests'].includes(f)) files(p, out) } else if (/\.(ts|tsx)$/.test(f)) out.push(p)
  }
  return out
}

describe('allocation boundary', () => {
  it('nothing outside src/server/allocation/claims.ts inserts into or updates bed_claim', () => {
    const offenders: string[] = []
    for (const f of [...files(path.join(ROOT, 'src')), ...files(path.join(ROOT, 'app'))]) {
      if (f.endsWith(path.join('allocation', 'claims.ts'))) continue
      const text = readFileSync(f, 'utf8')
      if (/(insert|update)\(\s*bedClaim\s*\)/.test(text) || /(INSERT\s+INTO|UPDATE)\s+bed_claim/i.test(text)) offenders.push(path.relative(ROOT, f))
    }
    expect(offenders).toEqual([])
  })
})
