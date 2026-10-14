/// <reference types="vite/client" />
/**
 * AT-040: proposed-policy switches (P-01 to P-14). PROPOSED, pending client sign-off: none of these is an approved decision.
 *
 *  - the registry, docs/DECISIONS.md section 15 and the SRS sign-off register (section 17, and Appendix C) stay in step: a P-number that
 *    exists in one and not the others fails this test; the default each document gives is the default the registry ships;
 *  - every proposed setting is listed in System configuration as pending sign-off (the listing API and the screen);
 *  - changing it is a new audited configuration version (never an edit), changing it back is another one, and the registry default is the
 *    previous behaviour again.
 * The behaviour in both states is tested by the package that owns the policy (P-01 AT-033, P-02 AT-034, the others AT-035 to AT-037).
 * Private database: the test changes global settings.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createIsolated, call } from '../access/isolated'
import { invKit } from './kit'
import { CONFIG, getConfig, type ConfigDef, type ConfigKey } from '@/server/config/registry'
import { ALL_ACTIONS } from '@/server/policy'
import { GET as listRoute } from '../../../app/api/v1/access/config/route'
import { PUT as setRoute } from '../../../app/api/v1/access/config/[key]/route'
import { getDb } from '@/server/db/client'

const iso = await createIsolated()
afterAll(() => iso.close())
const k = invKit(iso)

const ROOT = path.resolve(__dirname, '../../../..')
const decisions = readFileSync(path.join(ROOT, 'docs/DECISIONS.md'), 'utf8')
const srs = readFileSync(path.join(ROOT, 'docs/source/srs-v1.0.md'), 'utf8')
const configPage = readFileSync(path.join(ROOT, 'platform/app/(app)/config/page.tsx'), 'utf8')

/** Proposals that change no setting: their default is documented and they are not in the registry. */
const NO_SETTING: Record<string, { action: string; ships: 'ON' | 'OFF' }> = { 'P-14': { action: 'housekeeping_readiness.assign', ships: 'ON' } }

const proposed = (Object.keys(CONFIG) as ConfigKey[]).map(key => ({ key, def: CONFIG[key] as ConfigDef })).filter(x => x.def.proposed)
const byP = new Map<string, { key: ConfigKey; def: ConfigDef }[]>()
for (const x of proposed) byP.set(x.def.proposed!, [...(byP.get(x.def.proposed!) ?? []), x])

/* ---------------- parse the documents ---------------- */

interface DocRow { p: string; text: string; cells: string[] }
/** DECISIONS.md section 15: `| P-01 | proposal | `setting` | ships | status |`. */
function decisionsRows(): DocRow[] {
  const sec = decisions.slice(decisions.indexOf('## 15. Proposed policies'), decisions.indexOf('## Open questions for Grand Hyatt'))
  return sec.split('\n').filter(l => /^\|\s*P-\d\d\s*\|/.test(l)).map(l => {
    const cells = l.split('|').slice(1, -1).map(c => c.trim())
    return { p: cells[0], text: cells.join(' | '), cells }
  })
}
/** SRS section 17: rows start with the P-number in the first column; the cell text wraps over the lines that follow, until a blank line. */
function srsRegisterRows(): DocRow[] {
  const sec = srs.slice(srs.indexOf('# 17. Assumptions and Grand Hyatt Sign-off Register'), srs.indexOf('# 18. Implementation Sequence and Release Gates'))
  const rows: DocRow[] = []
  let cur: string[] | undefined
  for (const line of sec.split('\n')) {
    const m = /^\s{2}(P-\d\d)\s+(.*)$/.exec(line)
    if (m) { if (cur) rows.push(toRow(cur)); cur = [m[1] + ' ' + m[2]]; continue }
    if (cur && line.trim() === '') { rows.push(toRow(cur)); cur = undefined; continue }
    if (cur) cur.push(line.trim())
  }
  if (cur) rows.push(toRow(cur))
  return rows
  function toRow(lines: string[]): DocRow { const text = lines.join(' ').replace(/\s+/g, ' '); return { p: text.slice(0, 4), text, cells: [text] } }
}
/** Appendix C: table rows that carry a P-number and a default (ON, OFF or cancel). */
function appendixRows(): { ps: string[]; token: string | null; text: string }[] {
  const sec = srs.slice(srs.indexOf('# Appendix C'), srs.indexOf('# Approval'))
  return sec.split('\n').filter(l => l.startsWith('|') && /P-\d\d/.test(l)).map(l => {
    const status = l.split('|').slice(1, -1).map(c => c.trim()).pop() ?? ''
    const ps = [...l.matchAll(/P-\d\d/g)].map(m => m[0])
    const token = /\b(ON|OFF|cancel)\b/.exec(status)?.[1] ?? null
    return { ps: [...new Set(ps)], token, text: l }
  })
}

/** What a document must say about the shipped default of one setting. */
function tokensOf(def: ConfigDef, doc: 'decisions' | 'srs'): string[] {
  const v = def.default as unknown
  if (typeof v === 'boolean') return [v ? 'ON' : 'OFF']
  if (typeof v === 'string') return [v]
  if (typeof v === 'number') return v > 0 ? ['ON', String(v)] : ['OFF']
  if (Array.isArray(v)) return doc === 'decisions' ? ['ON', 'OFF'] : ['ON'] // a list: the D-03 actions ON; DECISIONS also says the extras are OFF, the SRS says they are optional
  if (v && typeof v === 'object') return Object.values(v as Record<string, string>) // office hours: 08:00 and 20:00
  return []
}
const hasWord = (text: string, token: string) => new RegExp(/^[A-Z]+$/.test(token) ? `\\b${token}\\b` : token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(text)

describe('AT-040 the registry and the documents agree on which policies are proposed', () => {
  const dRows = decisionsRows()
  const sRows = srsRegisterRows()

  it('a P-number exists in the registry (or is a documented no-setting proposal), in DECISIONS section 15, in SRS section 17 and in Appendix C, or in none', () => {
    const inRegistry = new Set([...byP.keys(), ...Object.keys(NO_SETTING)])
    const inDecisions = new Set(dRows.map(r => r.p))
    const inSrs = new Set(sRows.map(r => r.p))
    const inAppendix = new Set(appendixRows().flatMap(r => r.ps))
    const all = [...new Set([...inRegistry, ...inDecisions, ...inSrs, ...inAppendix])].sort()
    const missing = all.flatMap(p => [
      !inRegistry.has(p) && `${p} is documented but has no registry setting (and is not a listed no-setting proposal)`,
      !inDecisions.has(p) && `${p} is missing from DECISIONS.md section 15`,
      !inSrs.has(p) && `${p} is missing from the SRS sign-off register (section 17)`,
      !inAppendix.has(p) && `${p} is missing from SRS Appendix C`,
    ]).filter(Boolean)
    expect(missing).toEqual([])
    expect(all.length).toBeGreaterThanOrEqual(14)
  })

  it('every setting named in DECISIONS section 15 exists in the registry as a proposal with that same P-number, and every proposed registry entry is named there', () => {
    const named = new Map<string, string>() // setting -> P
    for (const r of dRows) for (const m of r.cells[2].matchAll(/`([a-z_]+\.[a-z_]+)`/g)) named.set(m[1], r.p)
    const problems: string[] = []
    for (const [key, p] of named) {
      if (NO_SETTING[p] && key === NO_SETTING[p].action) { if (!ALL_ACTIONS.includes(key as never)) problems.push(`${p}: ${key} is not a policy action`); continue }
      const e = (CONFIG as Record<string, ConfigDef>)[key]
      if (!e) problems.push(`${p}: ${key} is not in the registry`)
      else if (e.proposed !== p) problems.push(`${p}: ${key} is registered as ${e.proposed ?? 'not proposed'}`)
    }
    for (const x of proposed) if (!named.has(x.key)) problems.push(`${x.def.proposed}: ${x.key} is in the registry but not named in DECISIONS section 15`)
    expect(problems).toEqual([])
  })

  it('a proposal is never recorded as decided: status open, description starts "PROPOSED, pending client sign-off", every DECISIONS and SRS row says PROPOSED, pending client sign-off', () => {
    for (const x of proposed) {
      expect(x.def.status, x.key).toBe('open')
      expect(x.def.description, x.key).toMatch(/^PROPOSED, pending client sign-off \(P-\d\d/)
      expect(x.def.description, x.key).toContain(x.def.proposed!)
      expect(x.def.ref, x.key).toBe(x.def.proposed)
    }
    for (const r of decisionsRows()) expect(r.cells[4], r.p).toMatch(/^PROPOSED, pending client sign-off/)
    // the SRS register is a wrapped plain-text table, so its cells interleave: "PROPOSED, pending" is what survives intact
    for (const r of srsRegisterRows()) expect(r.text, r.p).toMatch(/PROPOSED, pending/)
  })

  it('the shipped default in the registry is the default each document gives (ON, OFF, the value)', () => {
    const problems: string[] = []
    for (const [p, xs] of byP) {
      const d = dRows.find(r => r.p === p)
      const s = sRows.find(r => r.p === p)
      for (const x of xs) {
        for (const tok of tokensOf(x.def, 'decisions')) if (d && !hasWord(`${d.cells[1]} ${d.cells[3]}`, tok)) problems.push(`${p} ${x.key}: DECISIONS does not say "${tok}"`)
        for (const tok of tokensOf(x.def, 'srs')) if (s && !hasWord(s.text, tok)) problems.push(`${p} ${x.key}: the SRS register does not say "${tok}"`)
      }
    }
    for (const [p, v] of Object.entries(NO_SETTING)) {
      if (!hasWord(dRows.find(r => r.p === p)!.cells[3], v.ships)) problems.push(`${p}: DECISIONS does not say ${v.ships}`)
      if (!hasWord(sRows.find(r => r.p === p)!.text, v.ships)) problems.push(`${p}: the SRS register does not say ${v.ships}`)
    }
    // a boolean that ships ON must not be documented as OFF in the "Ships" column of a single-setting row (and the other way round)
    for (const [p, xs] of byP) {
      const d = dRows.find(r => r.p === p)
      const bools = xs.filter(x => typeof x.def.default === 'boolean')
      if (d && xs.length === 1 && bools.length === 1) {
        const want = bools[0].def.default ? 'ON' : 'OFF'
        if (d.cells[3] !== want) problems.push(`${p}: DECISIONS ships column says "${d.cells[3]}" but the registry ships ${want}`)
      }
    }
    // Appendix C: the default it names for a P-number
    for (const row of appendixRows()) {
      if (!row.token) continue
      for (const p of row.ps) {
        const xs = byP.get(p)
        const want = xs?.find(x => typeof x.def.default === 'boolean' || typeof x.def.default === 'string')
        if (NO_SETTING[p]) { if (!row.text.includes(NO_SETTING[p].ships) && !row.text.includes(row.token)) problems.push(`${p}: Appendix C default`) ; if (row.token !== NO_SETTING[p].ships && row.ps.length === 1) problems.push(`${p}: Appendix C says ${row.token} but the proposal ships ${NO_SETTING[p].ships}`); continue }
        if (!want) continue
        const expected = typeof want.def.default === 'string' ? want.def.default : want.def.default ? 'ON' : 'OFF'
        if (row.ps.length === 1 && row.token !== expected) problems.push(`${p}: Appendix C says ${row.token} but the registry ships ${expected}`)
      }
    }
    expect(problems).toEqual([])
  })

  it('P-02 ships the D-03 actions ON and the extra proposals OFF; P-01 ships ON', () => {
    const list = CONFIG['auth.reauth_actions'].default as string[]
    expect([...list].sort()).toEqual(['access.role_change', 'emergency.initiate', 'waitlist.queue_override'])
    expect(CONFIG['approvals.escalation_backup'].default).toBe(true)
  })
})

describe('AT-040 System configuration lists every proposal as pending sign-off', () => {
  it('the listing API marks each proposed setting with its P-number and the default; the screen shows "pending client sign-off"', async () => {
    const sa = await k.cast('SA')
    const r = await call(listRoute, { method: 'GET', cookie: await sa.cookie() })
    expect(r.status).toBe(200)
    const rows = r.body.data as { key: string; proposed: string | null; default: unknown; status: string; source: string; version: number | null }[]
    for (const x of proposed) {
      const row = rows.find(y => y.key === x.key)
      expect(row, `${x.key} is listed`).toBeDefined()
      expect(row!.proposed).toBe(x.def.proposed)
      expect(row!.default).toEqual(x.def.default)
      expect(row!.status).toBe('open')
    }
    expect(rows.filter(y => y.proposed).map(y => y.key).sort()).toEqual(proposed.map(x => x.key).sort())
    expect(configPage).toContain('pending client sign-off')
    expect(configPage).toMatch(/Proposed ·/)
  })
})

/** A value that is valid for the setting and different from its current one. */
function other(key: ConfigKey, current: unknown, options?: string[]): unknown {
  if (typeof current === 'boolean') return !current
  if (typeof current === 'number') return current === 0 ? 1 : 0
  if (typeof current === 'string') return (options ?? []).find(o => o !== current) ?? current
  if (Array.isArray(current)) return current.length ? [] : ['emergency.initiate', 'emergency.decide', 'access.role_change', 'access.grant', 'waitlist.queue_override']
  if (current && typeof current === 'object') return { ...(current as object), from: '09:30' }
  throw new Error('no alternative for ' + key)
}

describe('AT-040 changing a proposed policy is a new audited configuration version', () => {
  it.each(proposed.map(x => [x.key, x] as const))('%s: change it, change it back; every change is a new version with before and after in the audit log', async (key, x) => {
    const sa = await k.cast('SA')
    const cookie = await sa.cookie()
    const listed = (await call(listRoute, { method: 'GET', cookie })).body.data as { key: string; options?: string[]; version: number | null }[]
    const row = listed.find(y => y.key === key)!
    const start = x.def.default
    expect(await getConfig(getDb(), key), 'before anything is saved the registry default applies').toEqual(start)

    const changed = other(key, start, row.options)
    const r1 = await call(setRoute, { method: 'PUT', body: { value: changed, reason: 'AT-040: trying the other state' }, cookie, params: { key } })
    expect(r1.status, JSON.stringify(r1.body)).toBe(200)
    const v1 = r1.body.data.version as number
    expect(v1).toBe((row.version ?? 0) + 1)
    expect(await getConfig(getDb(), key)).toEqual(changed)

    const r2 = await call(setRoute, { method: 'PUT', body: { value: start, reason: 'AT-040: back to the shipped default' }, cookie, params: { key } })
    expect(r2.status).toBe(200)
    expect(r2.body.data.version).toBe(v1 + 1)
    expect(await getConfig(getDb(), key), 'the shipped default is the previous behaviour again').toEqual(start)

    // the old version is still there (nothing was edited), and each change is in the audit log with the actor, the reason and before/after
    const versions = (await iso.admin.query<{ version: number; value: unknown; reason: string; decision_ref: string; decision_status: string }>(
      `SELECT version, value, reason, decision_ref, decision_status FROM config_item WHERE key = $1 AND scope_site_id IS NULL ORDER BY version`, [key])).rows
    expect(versions.map(v => v.version)).toEqual(Array.from({ length: versions.length }, (_, i) => i + 1))
    expect(versions.at(-2)).toMatchObject({ value: changed, decision_ref: x.def.proposed, decision_status: 'open' })
    const events = (await iso.admin.query<{ actor_user_id: string; actor_role: string; reason: string; before: any; after: any }>(
      `SELECT actor_user_id, actor_role, reason, before, after FROM audit_event WHERE action = 'config.changed' AND after->>'key' = $1 ORDER BY seq DESC LIMIT 2`, [key])).rows
    expect(events).toHaveLength(2)
    expect(events[1]).toMatchObject({ actor_user_id: sa.userId, actor_role: 'SA', reason: 'AT-040: trying the other state' })
    expect(events[1].before.value).toEqual(start)
    expect(events[1].after.value).toEqual(changed)
    expect(events[1].after).toMatchObject({ decisionRef: x.def.proposed, decisionStatus: 'open' })
    expect(events[0].after.value).toEqual(start)

    // history is append-only for everyone, the application login included
    await expect(iso.admin.query(`UPDATE config_item SET value = '{}'::jsonb WHERE key = $1`, [key])).rejects.toThrow()
    // and an invalid value, or a change without a reason, is refused and writes nothing
    const bad = await call(setRoute, { method: 'PUT', body: { value: 'not a valid value', reason: 'x' }, cookie, params: { key } })
    expect(bad.status).toBe(422)
    const noReason = await call(setRoute, { method: 'PUT', body: { value: start }, cookie, params: { key } })
    expect(noReason.status).toBe(422)
  })

  it('only a Super Admin can change a proposal: an Accommodation Admin is refused and nothing is written', async () => {
    const p = await k.property({ beds: 0 })
    const aa = await k.cast('AA', { siteId: p.siteId })
    const before = (await iso.admin.query(`SELECT count(*)::int AS n FROM config_item WHERE key = 'approvals.escalation_backup'`)).rows[0].n
    const r = await call(setRoute, { method: 'PUT', body: { value: false, reason: 'trying' }, cookie: await aa.cookie(), params: { key: 'approvals.escalation_backup' } })
    expect(r.status).toBe(403)
    expect((await iso.admin.query(`SELECT count(*)::int AS n FROM config_item WHERE key = 'approvals.escalation_backup'`)).rows[0].n).toBe(before)
  })
})
