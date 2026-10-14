import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { admin, closeAll, newSite, uniq } from '../harness'
import { api, auditRows, countStaff, HEADER, person, seedStaff, type Person } from './helpers'
import { parseCsv } from '@/server/commands/staff/csv'

afterAll(closeAll)

const tagOf = () => uniq('IMP').replace(/-/g, '').toUpperCase()
const countPrefix = async (p: string) => Number((await admin().query(`SELECT count(*) FROM staff_profile WHERE employee_id LIKE $1`, [`${p}%`])).rows[0].count)
const batchesBy = async (u: Person) => Number((await admin().query(`SELECT count(*) FROM import_batch WHERE created_by = $1`, [u.user.id])).rows[0].count)
const row = (id: string, name: string, extra = ',Spa,3,+971501234567,,2026-10-01,Active,Contact,+971500000000') => `${id},${name},Female${extra}`
const setPolicy = async (v: 'save_valid' | 'all_or_nothing') => {
  await admin().query(
    `INSERT INTO config_item (key, version, value) SELECT 'import.partial_policy', coalesce(max(version), 0) + 1, $1::jsonb FROM config_item WHERE key = 'import.partial_policy' AND scope_site_id IS NULL`,
    [JSON.stringify(v)])
}

/** The standard mixed file: valid, DB duplicate, in-file duplicate (case + spaces), bad date, formula, ragged row, valid with a note. */
async function mixedFile() {
  const p = tagOf()
  const existing = await seedStaff({ employeeId: `${p}EX`, fullName: 'Already Here' })
  const csv = [
    HEADER,
    row(`${p}01`, 'Valid One'),                                                  // row 2: new
    row(`${p.toLowerCase()}ex`, 'Dup Of Directory'),                              // row 3: duplicate (directory, different case)
    row(` ${p.toLowerCase()}01 `, 'Dup Within File'),                             // row 4: duplicate (file, case + spaces)
    row(`${p}04`, 'Bad Date', ',Spa,3,,,2026-13-45,Active,,'),                    // row 5: invalid date
    row(`${p}05`, '"=HYPERLINK(""http://evil"",""click"")"'),                     // row 6: formula
    `${p}06,Ragged Row,Female`,                                                   // row 7: too few cells
    `${p}07,Valid Two,,,,,,,,,`,                                                  // row 8: new, with notes
  ].join('\r\n')
  return { p, csv, existing }
}

describe('AT-004 CSV preview', () => {
  let sa: Person, aa: Person
  beforeAll(async () => { sa = await person('SA'); aa = await person('AA') })

  it('AT-004 separates the outcome of every row and commits nothing', async () => {
    const { p, csv } = await mixedFile()
    const before = await countPrefix(p)
    expect(before).toBe(1) // only the existing record
    const createdEventsBefore = (await auditRows('staff.created')).length

    const r = await api.preview(aa, csv, 'staff.csv')
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    const b = r.body.data
    expect(b).toMatchObject({ status: 'previewed', fileName: 'staff.csv', policy: 'save_valid', canConfirm: true })
    expect(b.summary).toMatchObject({ total: 7, new: 2, duplicate: 2, invalid: 3, withWarnings: 1, created: null, rejected: null })
    const byRow = Object.fromEntries(b.rows.map((x: { rowNo: number }) => [x.rowNo, x]))
    expect(Object.keys(byRow).map(Number)).toEqual([2, 3, 4, 5, 6, 7, 8])
    expect(byRow[2]).toMatchObject({ classification: 'new', reasons: [], employeeId: `${p}01`, fullName: 'Valid One' })
    expect(byRow[3]).toMatchObject({ classification: 'duplicate' })
    expect(byRow[3].reasons[0]).toMatch(/already exists in the directory/)
    expect(byRow[4]).toMatchObject({ classification: 'duplicate' })
    expect(byRow[4].reasons[0]).toMatch(/already appears on row 2/)
    expect(byRow[5]).toMatchObject({ classification: 'invalid' })
    expect(byRow[5].reasons.join()).toMatch(/Joining date/)
    expect(byRow[6]).toMatchObject({ classification: 'invalid' })
    expect(byRow[6].reasons.join()).toMatch(/formula/)
    expect(byRow[7]).toMatchObject({ classification: 'invalid' })
    expect(byRow[7].reasons.join()).toMatch(/3 values but the header has 11/)
    expect(byRow[8]).toMatchObject({ classification: 'new' })
    expect(byRow[8].warnings.length).toBeGreaterThan(0)

    // nothing was committed to the directory, and no staff event was written
    expect(await countPrefix(p)).toBe(1)
    expect((await auditRows('staff.created')).length).toBe(createdEventsBefore)
    expect(await countStaff(`${p}01`)).toBe(0)
    // the batch is stored, previewed, and audited
    const stored = (await admin().query(`SELECT status, total_rows, new_rows, duplicate_rows, invalid_rows, created_by FROM import_batch WHERE id = $1`, [b.id])).rows[0]
    expect(stored).toEqual({ status: 'previewed', total_rows: 7, new_rows: 2, duplicate_rows: 2, invalid_rows: 3, created_by: aa.user.id })
    const ev = await auditRows('staff.import.previewed', b.id)
    expect(ev).toHaveLength(1)
    expect(ev[0].after).toMatchObject({ total: 7, new: 2, duplicate: 2, invalid: 3, fileName: 'staff.csv' })
    // reading it back gives the same preview
    const again = await api.batch(aa, b.id)
    expect(again.body.data.summary).toEqual(b.summary)
    expect(again.body.data.rows).toEqual(b.rows)
  })

  it('previewing twice makes two batches and still commits nothing', async () => {
    const { p, csv } = await mixedFile()
    const a = await api.preview(sa, csv)
    const b = await api.preview(sa, csv)
    expect(a.body.data.id).not.toBe(b.body.data.id)
    expect(await countPrefix(p)).toBe(1)
  })

  it('reads a file with a BOM, CRLF, header aliases, quoted commas and line breaks', async () => {
    const p = tagOf()
    const csv = `﻿Employee No,Name,Sex,Dept,Mobile\r\n${p}1,"Lopez, Ana ""Anita""",F,"Food\r\n& Beverage",+971 50 123 4567\r\n`
    const r = await api.preview(sa, csv)
    expect(r.status).toBe(200)
    expect(r.body.data.summary).toMatchObject({ total: 1, new: 1 })
    expect(r.body.data.rows[0]).toMatchObject({ fullName: 'Lopez, Ana "Anita"' }) // the preview echoes the cell as written
    expect(await api.confirm(sa, r.body.data.id)).toMatchObject({ status: 200 })
    const saved = (await admin().query(`SELECT full_name, department, gender, phone FROM staff_profile WHERE employee_id = $1`, [`${p}1`])).rows[0]
    expect(saved).toEqual({ full_name: 'Lopez, Ana "Anita"', department: 'Food & Beverage', gender: 'female', phone: '+971 50 123 4567' })
  })

  it('refuses unreadable files with a reason and next step, and stores no batch', async () => {
    const before = await batchesBy(sa)
    const cases: [string, RegExp][] = [
      ['', /empty/],
      [HEADER, /no staff rows/],
      ['full_name\nAna', /employee_id/],
      ['employee_id,full_name\nE1,"unterminated', /never closes/],
      ['employee_id,full_name\nE1,Jos�', /UTF-8/],
      ['employee_id;full_name\nE1;Ana', /semicolons/],
    ]
    for (const [csv, why] of cases) {
      const r = await api.preview(sa, csv)
      expect(r.status, csv).toBe(422)
      expect(r.body.reason).toMatch(why)
      expect(r.body.next).toBeTruthy()
    }
    const big = await api.preview(sa, 'a'.repeat(2_000_001))
    expect(big.status).toBe(422)
    expect(big.body.fields.csv).toMatch(/2 MB/)
    expect(await batchesBy(sa)).toBe(before)
  })

  it('a huge cell and many ragged rows are rejected row by row without echoing the cell', async () => {
    const p = tagOf()
    const r = await api.preview(sa, `employee_id,full_name\r\n${p}1,${'x'.repeat(200_000)}\r\n${p}2,Fine\r\n${p}3\r\n`)
    expect(r.status).toBe(200)
    expect(r.body.data.summary).toMatchObject({ total: 3, new: 1, invalid: 2 })
    expect(JSON.stringify(r.body).length).toBeLessThan(5000)
    const stored = (await admin().query(`SELECT max(length(raw::text)) AS n FROM import_row WHERE batch_id = $1`, [r.body.data.id])).rows[0]
    expect(Number(stored.n)).toBeLessThan(1000)
  })

  it('is for people who may import: SA, AA and StaffMaster. Everyone else is refused before the file is read', async () => {
    const site = await newSite()
    const csv = `${HEADER}\n${row('X1', 'No One')}`
    for (const role of ['Rec', 'Sec', 'Res', 'Aud', 'Mgr', 'MC', 'Tech', 'Vend'] as const) {
      const pr = await person(role, { siteId: site })
      expect((await api.preview(pr, csv)).status, role).toBe(403)
    }
    const master = await person('Rec', { siteId: site, caps: ['StaffMaster'] })
    expect((await api.preview(master, `employee_id,full_name\n${tagOf()}1,Via Master`)).status).toBe(200)
  })

  it('a batch belongs to the person who uploaded it (and Super Admins): anyone else gets 404', async () => {
    const mine = await api.preview(aa, `employee_id,full_name\n${tagOf()}1,Mine`)
    const id = mine.body.data.id as string
    const other = await person('AA')
    expect((await api.batch(other, id)).status).toBe(404)
    expect((await api.confirm(other, id)).status).toBe(404)
    expect((await api.rejected(other, id)).status).toBe(404)
    expect((await api.batch(sa, id)).status).toBe(200)
    expect((await api.batch(aa, 'not-a-uuid')).status).toBe(404)
    expect((await api.batch(aa, crypto.randomUUID())).status).toBe(404)
  })
})

describe('AT-005 CSV partial error', () => {
  let sa: Person, aa: Person
  beforeAll(async () => { sa = await person('SA'); aa = await person('AA') })

  it('AT-005 saves the valid rows once, reports the rejected ones, and the summary adds up', async () => {
    const { p, csv } = await mixedFile()
    const pv = await api.preview(aa, csv)
    const id = pv.body.data.id as string
    const c = await api.confirm(aa, id)
    expect(c.status).toBe(200)
    expect(c.body.data).toMatchObject({ batchId: id, policy: 'save_valid', total: 7, created: 2, rejected: 5, duplicate: 2, invalid: 3, rejectedFileAvailable: true })
    expect(c.body.data.created + c.body.data.rejected).toBe(c.body.data.total)

    // exactly the valid rows exist, once, from the CSV
    expect(await countPrefix(p)).toBe(3) // the existing record + 2 new
    const saved = (await admin().query(`SELECT employee_id, full_name, source, department, grade, phone, joining_date::text AS jd, emergency_contact FROM staff_profile WHERE employee_id LIKE $1 AND source = 'csv' ORDER BY employee_id`, [`${p}%`])).rows
    expect(saved).toEqual([
      { employee_id: `${p}01`, full_name: 'Valid One', source: 'csv', department: 'Spa', grade: 3, phone: '+971501234567', jd: '2026-10-01', emergency_contact: 'Contact · +971500000000' },
      { employee_id: `${p}07`, full_name: 'Valid Two', source: 'csv', department: null, grade: null, phone: null, jd: null, emergency_contact: null },
    ])
    // the batch and each row's outcome
    const bt = (await admin().query(`SELECT status, policy, created_count, rejected_count, confirmed_by FROM import_batch WHERE id = $1`, [id])).rows[0]
    expect(bt).toEqual({ status: 'confirmed', policy: 'save_valid', created_count: 2, rejected_count: 5, confirmed_by: aa.user.id })
    const outs = (await admin().query(`SELECT outcome, count(*)::int AS n, count(staff_id)::int AS linked FROM import_row WHERE batch_id = $1 GROUP BY outcome ORDER BY outcome`, [id])).rows
    expect(outs).toEqual([{ outcome: 'created', n: 2, linked: 2 }, { outcome: 'rejected', n: 5, linked: 0 }])
    // audit: one event for the batch with real counts, one per created profile
    const ev = await auditRows('staff.import.confirmed', id)
    expect(ev).toHaveLength(1)
    expect(ev[0].after).toMatchObject({ total: 7, created: 2, rejected: 5, duplicate: 2, invalid: 3, policy: 'save_valid' })
    const perRecord = (await admin().query(`SELECT entity_id, after FROM audit_event WHERE action = 'staff.created' AND after->>'importBatchId' = $1`, [id])).rows
    expect(perRecord).toHaveLength(2)
    expect(perRecord.map(x => x.after.employeeId).sort()).toEqual([`${p}01`, `${p}07`])
    // the reloaded batch shows every outcome
    const view = await api.batch(aa, id)
    expect(view.body.data.status).toBe('confirmed')
    expect(view.body.data.summary).toMatchObject({ created: 2, rejected: 5, total: 7 })
    expect(view.body.data.rows.filter((r: { outcome: string }) => r.outcome === 'created')).toHaveLength(2)
    // and the people are in the directory
    const found = await api.list(sa, `?q=${p}01`)
    expect(found.body.data.items[0]).toMatchObject({ fullName: 'Valid One', source: 'csv' })
  })

  it('AT-005 confirming a second time saves nothing more', async () => {
    const p = tagOf()
    const pv = await api.preview(sa, `employee_id,full_name\n${p}1,One\n${p}2,Two`)
    expect((await api.confirm(sa, pv.body.data.id)).status).toBe(200)
    const again = await api.confirm(sa, pv.body.data.id)
    expect(again.status).toBe(409)
    expect(again.body.reason).toMatch(/already confirmed: 2 saved, 0 rejected/)
    expect(again.body.detail.result).toMatchObject({ created: 2, rejected: 0, total: 2 })
    expect(await countPrefix(p)).toBe(2)
    expect(await auditRows('staff.import.confirmed', pv.body.data.id)).toHaveLength(1)
  })

  it('AT-005 several simultaneous confirms of one batch: exactly one saves', async () => {
    const p = tagOf()
    const lines = Array.from({ length: 40 }, (_, i) => `${p}${String(i).padStart(3, '0')},Person ${i}`)
    const pv = await api.preview(sa, ['employee_id,full_name', ...lines].join('\n'))
    const rs = await Promise.all(Array.from({ length: 6 }, () => api.confirm(sa, pv.body.data.id)))
    expect(rs.filter(r => r.status === 200)).toHaveLength(1)
    expect(rs.filter(r => r.status === 409)).toHaveLength(5)
    expect(await countPrefix(p)).toBe(40)
    expect(await auditRows('staff.import.confirmed', pv.body.data.id)).toHaveLength(1)
    const events = (await admin().query(`SELECT count(*)::int AS n FROM audit_event WHERE action = 'staff.created' AND after->>'importBatchId' = $1`, [pv.body.data.id])).rows[0].n
    expect(events).toBe(40)
  })

  it('a row whose ID is taken between preview and confirm is rejected with that reason; the rest are saved; numbers add up', async () => {
    const p = tagOf()
    const pv = await api.preview(sa, `employee_id,full_name\n${p}A,Alpha\n${p}B,Bravo\n${p}C,Charlie`)
    expect(pv.body.data.summary.new).toBe(3)
    expect((await api.create(sa, { employeeId: `${p}b`, fullName: 'Taken Meanwhile' })).status).toBe(200)
    const c = await api.confirm(sa, pv.body.data.id)
    expect(c.status).toBe(200)
    expect(c.body.data).toMatchObject({ total: 3, created: 2, rejected: 1, duplicate: 1, invalid: 0 })
    expect((await admin().query(`SELECT full_name FROM staff_profile WHERE lower(employee_id) = lower($1)`, [`${p}B`])).rows).toEqual([{ full_name: 'Taken Meanwhile' }])
    const rej = await api.rejected(sa, pv.body.data.id)
    const [, ...rows] = parseCsv(rej.text)
    expect(rows).toHaveLength(1)
    expect(rows[0][1]).toMatch(/taken by another change/)
    expect(rows[0][2]).toBe(`${p}B`)
  })

  it('a confirm racing a manual create of the same ID: one record, totals add up either way', async () => {
    const p = tagOf()
    const lines = Array.from({ length: 20 }, (_, i) => `${p}${String(i).padStart(2, '0')},Bulk ${i}`)
    const pv = await api.preview(sa, ['employee_id,full_name', ...lines].join('\n'))
    const [c, m] = await Promise.all([api.confirm(sa, pv.body.data.id), api.create(sa, { employeeId: `${p}10`, fullName: 'Manual Ten' })])
    expect(c.status).toBe(200)
    expect(await countStaff(`${p}10`)).toBe(1)
    expect(c.body.data.created + c.body.data.rejected).toBe(20)
    expect(m.status === 200 ? c.body.data.created === 19 : c.body.data.created === 20).toBe(true)
    expect(await countPrefix(p)).toBe(20)
  })

  it('two uploads of the same file confirmed at the same moment: every person exists once', async () => {
    const p = tagOf()
    const csv = ['employee_id,full_name', ...Array.from({ length: 30 }, (_, i) => `${p}${String(i).padStart(2, '0')},Twin ${i}`)].join('\n')
    const [a, b] = [await api.preview(sa, csv), await api.preview(aa, csv)]
    const [ca, cb] = await Promise.all([api.confirm(sa, a.body.data.id), api.confirm(aa, b.body.data.id)])
    expect([ca.status, cb.status]).toEqual([200, 200])
    expect(ca.body.data.created + cb.body.data.created).toBe(30)
    expect(ca.body.data.rejected + cb.body.data.rejected).toBe(30)
    expect(ca.body.data.created + ca.body.data.rejected).toBe(30)
    expect(cb.body.data.created + cb.body.data.rejected).toBe(30)
    expect(await countPrefix(p)).toBe(30)
  })

  it('the database itself freezes a confirmed batch and its decided rows, and a profile comes from at most one row', async () => {
    const p = tagOf()
    const pv = await api.preview(sa, `employee_id,full_name\n${p}1,One\n${p}2,\n`)
    await api.confirm(sa, pv.body.data.id)
    const fail = async (sql: string) => { try { await admin().query(sql, [pv.body.data.id]); return 'ok' } catch (e) { return (e as { code?: string }).code } }
    expect(await fail(`UPDATE import_batch SET status = 'previewed', confirmed_at = NULL, created_count = NULL, rejected_count = NULL WHERE id = $1`)).toBe('GH001')
    expect(await fail(`UPDATE import_batch SET created_count = 99 WHERE id = $1`)).toBe('GH001')
    expect(await fail(`UPDATE import_row SET outcome = 'rejected', staff_id = NULL WHERE batch_id = $1 AND outcome = 'created'`)).toBe('GH001')
    expect(await fail(`UPDATE import_row SET classification = 'new' WHERE batch_id = $1 AND classification = 'invalid'`)).toBe('GH001')
    expect(await countPrefix(p)).toBe(1)
  })

  it('a file with no valid row cannot be confirmed, and says why', async () => {
    const p = tagOf()
    const pv = await api.preview(sa, `employee_id,full_name\n${p}1,\n${p}2,=bad()`)
    expect(pv.body.data.canConfirm).toBe(false)
    expect(pv.body.data.blocked).toMatchObject({ why: expect.stringMatching(/No row/), owner: expect.any(String), next: expect.any(String) })
    const c = await api.confirm(sa, pv.body.data.id)
    expect(c.status).toBe(409)
    expect(c.body.owner).toBeTruthy()
    expect(c.body.next).toBeTruthy()
    expect((await admin().query(`SELECT status FROM import_batch WHERE id = $1`, [pv.body.data.id])).rows[0].status).toBe('previewed')
  })

  it('a large file is processed in chunks and the counts are exact', async () => {
    const p = tagOf()
    const n = 1500
    const lines = Array.from({ length: n }, (_, i) => `${p}${String(i).padStart(4, '0')},Person ${i},Male,Laundry,${i % 7},+9715000${String(i).padStart(5, '0')}`)
    lines.push(`${p.toLowerCase()}0000,Repeat of the first,,,,`)
    const pv = await api.preview(sa, [HEADER.split(',').slice(0, 6).join(','), ...lines].join('\n'))
    expect(pv.body.data.summary).toMatchObject({ total: n + 1, new: n, duplicate: 1 })
    const c = await api.confirm(sa, pv.body.data.id)
    expect(c.body.data).toMatchObject({ created: n, rejected: 1, total: n + 1 })
    expect(await countPrefix(p)).toBe(n)
  })
})

describe('rejected rows file (export)', () => {
  let aa: Person
  beforeAll(async () => { aa = await person('AA') })

  it('is a CSV attachment with a reason column, available after preview and after confirm, and it is audited', async () => {
    const { p, csv } = await mixedFile()
    const pv = await api.preview(aa, csv)
    const id = pv.body.data.id as string
    const before = await api.rejected(aa, id)
    expect(before.status).toBe(200)
    expect(before.headers.get('content-type')).toMatch(/text\/csv/)
    expect(before.headers.get('content-disposition')).toMatch(/^attachment; filename="rejected-rows-[0-9a-f]{8}\.csv"$/)
    expect(before.headers.get('x-content-type-options')).toBe('nosniff')
    expect(before.text.startsWith('﻿')).toBe(true)
    const rows = parseCsv(before.text)
    expect(rows[0].slice(0, 4)).toEqual(['row', 'reason', 'employee_id', 'full_name'])
    expect(rows.slice(1).map(r => r[0])).toEqual(['3', '4', '5', '6', '7'])
    expect(rows.slice(1).every(r => r[1].length > 0)).toBe(true)
    await api.confirm(aa, id)
    const after = parseCsv((await api.rejected(aa, id)).text)
    expect(after.slice(1).map(r => r[0])).toEqual(['3', '4', '5', '6', '7'])
    expect((await auditRows('staff.import.rejected_exported', id))).toHaveLength(2)
    void p
  })

  it('the formula-injection guard: dangerous cells leave the system prefixed with an apostrophe', async () => {
    const p = tagOf()
    const evil = '=HYPERLINK("http://evil.example","click")'
    const csv = `employee_id,full_name,department,phone\n${p}1,"${evil.replace(/"/g, '""')}",Spa,+971501234567\n${p}2,@SUM(1+1),-cmd,+971501234567\n${p}3,Fine Name,Spa,+971501234567\n`
    const pv = await api.preview(aa, csv)
    expect(pv.body.data.summary).toMatchObject({ new: 1, invalid: 2 })
    const res = await api.rejected(aa, pv.body.data.id)
    // the raw file never contains a cell that starts with a formula character
    const lines = parseCsv(res.text).flat()
    for (const cell of lines) expect(cell, cell).not.toMatch(/^[=+\-@\t\r\n]/)
    expect(lines).toContain(`'${evil}`)
    expect(lines).toContain("'@SUM(1+1)")
    expect(lines).toContain("'-cmd")
    // the phone number of a rejected row starts with + and is guarded too
    expect(lines).toContain("'+971501234567")
    // and the bytes on the wire have the apostrophe before the equals sign
    expect(res.text).toContain(`"'=HYPERLINK(""http://evil.example"",""click"")"`)
  })

  it('needs the import action, belongs to the uploader, and is 404 for batches that do not exist', async () => {
    const pv = await api.preview(aa, `employee_id,full_name\n${tagOf()}1,\n`)
    const site = await newSite()
    for (const role of ['Rec', 'Sec', 'Res', 'Aud', 'Mgr'] as const) {
      expect((await api.rejected(await person(role, { siteId: site }), pv.body.data.id)).status, role).toBe(403)
    }
    expect((await api.rejected(aa, crypto.randomUUID())).status).toBe(404)
    expect((await api.rejected(aa, 'x')).status).toBe(404)
    const anon = await (await import('../../../app/api/v1/staff/import/[batchId]/rejected.csv/route')).GET(new Request('http://localhost:3000/x', { headers: { host: 'localhost:3000' } }), { params: { batchId: pv.body.data.id } })
    expect(anon.status).toBe(401)
  })
})

// Last on purpose: it changes the global import policy for a moment. Every other test above uses the default.
describe('AT-005 under the all-or-nothing policy', () => {
  let sa: Person
  beforeAll(async () => { sa = await person('SA') })

  it('any rejected row blocks the whole import, with reason, owner and next action; a clean file still imports', async () => {
    await setPolicy('all_or_nothing')
    try {
      const p = tagOf()
      const bad = await api.preview(sa, `employee_id,full_name\n${p}1,Good\n${p}2,\n`)
      expect(bad.body.data.policy).toBe('all_or_nothing')
      expect(bad.body.data.canConfirm).toBe(false)
      expect(bad.body.data.blocked.why).toMatch(/all-or-nothing/)
      const c = await api.confirm(sa, bad.body.data.id)
      expect(c.status).toBe(409)
      expect(c.body.reason).toMatch(/all-or-nothing/)
      expect(c.body.owner).toBeTruthy()
      expect(c.body.next).toMatch(/rejected rows/)
      expect(await countPrefix(p)).toBe(0)
      expect((await admin().query(`SELECT status FROM import_batch WHERE id = $1`, [bad.body.data.id])).rows[0].status).toBe('previewed')

      const good = await api.preview(sa, `employee_id,full_name\n${p}1,Good\n${p}3,Also Good\n`)
      expect(good.body.data.canConfirm).toBe(true)
      // one row is taken after the preview: still all or nothing, so nothing is saved and the batch stays confirmable-after-fresh-preview
      await api.create(sa, { employeeId: `${p}3`, fullName: 'Beat You To It' })
      const late = await api.confirm(sa, good.body.data.id)
      expect(late.status).toBe(409)
      expect(late.body.reason).toMatch(/nothing was saved/)
      expect(await countPrefix(p)).toBe(1) // only the manual one
      expect((await admin().query(`SELECT status FROM import_batch WHERE id = $1`, [good.body.data.id])).rows[0].status).toBe('previewed')
      expect(await auditRows('staff.import.confirmed', good.body.data.id)).toHaveLength(0)

      const clean = await api.preview(sa, `employee_id,full_name\n${p}8,Clean One\n${p}9,Clean Two\n`)
      const ok = await api.confirm(sa, clean.body.data.id)
      expect(ok.status).toBe(200)
      expect(ok.body.data).toMatchObject({ policy: 'all_or_nothing', created: 2, rejected: 0 })
    } finally {
      await setPolicy('save_valid')
    }
  })
})
