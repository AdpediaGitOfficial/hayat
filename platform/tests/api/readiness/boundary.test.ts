/**
 * Boundary (STAGE-3 section 8): a bed becomes Available only through a passed final inspection. Exactly one file may write
 * `state: 'available'` on a bed: src/server/commands/readiness/inspect.ts. This test reads every source file of the application
 * (src and app) and fails the build if any other file writes it, or writes a bed state it cannot read at a glance.
 * Seeds, migrations and tests are out of scope: they arrange data, they are not the running application.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(__dirname, '../../..')
const ALLOWED = new Set(['src/server/commands/readiness/inspect.ts'])

function files(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const p = path.join(dir, name)
    if (name === 'node_modules' || name === '.next') return []
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx|js|mjs)$/.test(name) ? [p] : []
  })
}
const sources = [...files(path.join(ROOT, 'src')), ...files(path.join(ROOT, 'app'))].map(p => ({ rel: path.relative(ROOT, p).split(path.sep).join('/'), text: readFileSync(p, 'utf8') }))

const writesAvailable = (text: string) =>
  /\bstate\s*:\s*['"`]available['"`]/.test(text) || /\bstate\s*=\s*['"`]available['"`]/.test(text) || /set\s+state\s*=\s*['"`]?available/i.test(text)

/** The object literal handed to `.set(` after `update(bed)`, found by matching braces. */
function bedSets(text: string): string[] {
  const out: string[] = []
  const re = /update\(\s*bed\s*\)\s*\.set\(\s*\{/g
  for (let m = re.exec(text); m; m = re.exec(text)) {
    let depth = 1, i = re.lastIndex
    while (i < text.length && depth > 0) { if (text[i] === '{') depth++; else if (text[i] === '}') depth--; i++ }
    out.push(text.slice(re.lastIndex, i - 1))
  }
  return out
}

describe('the only writer of bed state Available', () => {
  it('reads the application sources', () => { expect(sources.length).toBeGreaterThan(100) })

  it('no file but the final inspection writes state: available (object literal or SQL)', () => {
    const offenders = sources.filter(f => !ALLOWED.has(f.rel)
      && writesAvailable(f.text))
    expect(offenders.map(o => o.rel)).toEqual([])
  })

  it('every bed update sets state to a literal, so the check above cannot be bypassed with a variable', () => {
    const dynamic: string[] = []
    for (const f of sources) for (const set of bedSets(f.text)) {
      const m = /\bstate\s*(:\s*([^,}]+))?\s*(,|$)/.exec(set.replace(/stateReason|stateSince/g, 'X'))
      if (!m) continue
      const value = (m[2] ?? '').trim()
      if (!/^['"`][a-z_]+['"`]$/.test(value)) dynamic.push(`${f.rel}: state: ${value || '(shorthand)'}`)
    }
    expect(dynamic).toEqual([])
  })

  it('the detector catches the ways a writer could look (so a passing test means something)', () => {
    expect(writesAvailable(`await tx.update(bed).set({ state: 'available' }).where(x)`)).toBe(true)
    expect(writesAvailable(`await tx.execute(sql\`UPDATE bed SET state = 'available' WHERE id = 1\`)`)).toBe(true)
    expect(writesAvailable(`bed.state === 'available'`)).toBe(false)
    expect(bedSets(`tx.update(bed).set({ state: next, stateReason: null })`)[0]).toContain('state: next')
  })

  it('the allowed file really is the writer (the test would be vacuous otherwise)', () => {
    const w = sources.find(f => f.rel === 'src/server/commands/readiness/inspect.ts')!
    expect(w.text).toMatch(/state:\s*'available'/)
    expect(sources.filter(f => /update\(\s*bed\s*\)/.test(f.text)).length).toBeGreaterThan(4)
  })
})
