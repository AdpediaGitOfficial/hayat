import { describe, expect, it } from 'vitest'
import { CsvSyntaxError, guardCsvCell, parseCsv, serializeCsv } from '@/server/commands/staff/csv'
import { analyseRows, classifyRows, keysOf, MAX_ROWS, readStaffCsv, TEMPLATE_EXAMPLE, TEMPLATE_HEADER } from '@/server/commands/staff/importRules'
import { normaliseStaff, validateStaff } from '@/server/commands/staff/fields'

describe('CSV reader', () => {
  it('reads plain rows, CRLF, LF and a lone CR, and a missing final line break', () => {
    expect(parseCsv('a,b\r\n1,2\n3,4\r5,6')).toEqual([['a', 'b'], ['1', '2'], ['3', '4'], ['5', '6']])
  })
  it('drops a byte-order mark', () => {
    expect(parseCsv('﻿a,b\n1,2')).toEqual([['a', 'b'], ['1', '2']])
  })
  it('keeps commas, doubled quotes and line breaks inside quoted cells', () => {
    expect(parseCsv('a,b\n"x, y","say ""hi""\nthere"\n')).toEqual([['a', 'b'], ['x, y', 'say "hi"\nthere']])
  })
  it('empty cells, trailing commas and quoted empty cells', () => {
    expect(parseCsv('a,,c,\n"",,,')).toEqual([['a', '', 'c', ''], ['', '', '', '']])
  })
  it('an unterminated quote and text glued to a closing quote are errors with a row number', () => {
    expect(() => parseCsv('a,b\n"open,2\n')).toThrow(CsvSyntaxError)
    expect(() => parseCsv('a,b\n"x"y,2')).toThrow(/row 2/)
  })
  it('a quote in the middle of an unquoted cell is just a character', () => {
    expect(parseCsv('5" pipe,x')).toEqual([['5" pipe', 'x']])
  })
})

describe('formula-injection guard', () => {
  it.each(['=1+1', '+SUM(A1)', '-2+3', '@cmd', '\tx', '\rx', '\nx', '=HYPERLINK("http://evil","x")'])('prefixes %j', v => {
    expect(guardCsvCell(v)).toBe(`'${v}`)
  })
  it.each(['Ana', '', 'a=b', '12', "'quoted"])('leaves %j alone', v => { expect(guardCsvCell(v)).toBe(v) })
  it('is applied to every cell of every row, headers included, before quoting', () => {
    const out = serializeCsv([['=h', 'ok'], ['+1', '@x"y', 'a,b', 'line\nbreak', null, 7]])
    expect(out.startsWith('﻿')).toBe(true)
    expect(out.slice(1)).toBe(`'=h,ok\r\n'+1,"'@x""y","a,b","line\nbreak",,7\r\n`)
  })
  it('round-trips through the reader', () => {
    const rows = [['row', 'name'], ['2', 'Ana, "the" boss'], ['3', 'multi\nline']]
    expect(parseCsv(serializeCsv(rows))).toEqual(rows)
  })
})

describe('staff file reader', () => {
  const ok = (text: string) => {
    const r = readStaffCsv(text)
    if (!r.ok) throw new Error(`${r.reason}`)
    return r
  }
  it('refuses an empty file, whitespace, and a file with only a header', () => {
    for (const t of ['', '   \n  ', '﻿']) expect(readStaffCsv(t)).toMatchObject({ ok: false, reason: expect.stringMatching(/empty|no header/) })
    expect(readStaffCsv(TEMPLATE_HEADER)).toMatchObject({ ok: false, reason: 'The file has a header but no staff rows' })
    expect(readStaffCsv(`${TEMPLATE_HEADER}\n\n,,,,\n`)).toMatchObject({ ok: false, reason: 'The file has a header but no staff rows' })
  })
  it('reads the SRS template header and example', () => {
    const r = ok(`${TEMPLATE_HEADER}\r\n${TEMPLATE_EXAMPLE}\r\n`)
    expect(r.rows).toHaveLength(1)
    expect(r.rows[0].cells).toMatchObject({ employee_id: 'E3001', full_name: 'Hassan Ali', grade: '2', email: 'hassan@example.com', joining_date: '2026-10-12' })
    expect(r.ignoredColumns).toEqual([])
  })
  it('accepts header aliases, any case, spaces and a BOM; reports unknown columns', () => {
    const r = ok('﻿Employee No, Name ,Sex,Dept,Mobile Number,Favourite Colour\nE1,Ana,F,Spa,+97150123456,red')
    expect(r.rows[0].cells).toMatchObject({ employee_id: 'E1', full_name: 'Ana', gender: 'F', department: 'Spa', phone: '+97150123456' })
    expect(r.ignoredColumns).toEqual(['Favourite Colour'])
  })
  it('numbers rows like a spreadsheet (header = row 1) and skips blank lines without renumbering', () => {
    const r = ok('employee_id,full_name\nE1,A\n\n,\nE2,B')
    expect(r.rows.map(x => x.rowNo)).toEqual([2, 5])
    expect(r.blankSkipped).toBe(2)
  })
  it('refuses a file without the required columns, with a hint for semicolon files', () => {
    expect(readStaffCsv('full_name,department\nA,B')).toMatchObject({ ok: false, reason: expect.stringContaining('employee_id') })
    expect(readStaffCsv('employee_id;full_name\nE1;A')).toMatchObject({ ok: false, reason: expect.stringContaining('semicolons') })
  })
  it('refuses two columns that mean the same field', () => {
    expect(readStaffCsv('employee_id,id,full_name\nE1,E1,A')).toMatchObject({ ok: false, reason: expect.stringContaining('mean the same') })
  })
  it('refuses binary data, replacement characters (not UTF-8), broken quotes, and too many rows', () => {
    expect(readStaffCsv('employee_id,full_name\nE1,A\u0000')).toMatchObject({ ok: false, reason: expect.stringContaining('binary') })
    expect(readStaffCsv('employee_id,full_name\nE1,Jos�')).toMatchObject({ ok: false, reason: expect.stringContaining('UTF-8') })
    expect(readStaffCsv('employee_id,full_name\nE1,"A')).toMatchObject({ ok: false, reason: expect.stringContaining('never closes') })
    const many = 'employee_id,full_name\n' + Array.from({ length: MAX_ROWS + 1 }, (_, i) => `E${i},N`).join('\n')
    expect(readStaffCsv(many)).toMatchObject({ ok: false, reason: expect.stringContaining(String(MAX_ROWS)) })
  })
})

describe('row checks and classification', () => {
  const run = (rows: string[], existing: string[] = []) => {
    const r = readStaffCsv(['employee_id,full_name,gender,department,grade,phone,email,joining_date,employment_status,emergency_contact_name,emergency_contact_phone', ...rows].join('\n'))
    if (!r.ok) throw new Error(r.reason)
    const drafts = analyseRows(r.rows, r.headerCount)
    return classifyRows(drafts, new Set(existing))
  }
  it('a clean row is new; missing optional data only warns', () => {
    const [a, b] = run(['E1,Ana,Female,Spa,3,+971501234567,ana@x.com,2026-01-02,Active,Bo,+971500000000', 'E2,Bo,,,,,,,,,'])
    expect(a).toMatchObject({ classification: 'new', reasons: [], warnings: [] })
    expect(a.values).toMatchObject({ employeeId: 'E1', gender: 'female', grade: 3, emergencyContact: 'Bo · +971500000000' })
    expect(b.classification).toBe('new')
    expect(b.warnings).toHaveLength(3)
  })
  it('reports each problem with the field named', () => {
    const [r] = run(['E1,,Robot,Spa,-1,12,nope,2026-13-40,Left,,'])
    expect(r.classification).toBe('invalid')
    expect(r.reasons.join('|')).toMatch(/Full name is required/)
    expect(r.reasons.join('|')).toMatch(/Gender/)
    expect(r.reasons.join('|')).toMatch(/Grade/)
    expect(r.reasons.join('|')).toMatch(/Phone/)
    expect(r.reasons.join('|')).toMatch(/Email/)
    expect(r.reasons.join('|')).toMatch(/Joining date/)
    expect(r.reasons.join('|')).toMatch(/Left/)
  })
  it('rejects spreadsheet formulas in text fields', () => {
    const rows = run(['E1,=HYPERLINK("http://x"),,,,,,,,,', 'E2,@SUM(1),,,,,,,,,', 'E3,+cmd,,,,,,,,,', 'E4,-cmd,,,,,,,,,', 'E5,Ana,,=1+1,,,,,,,'])
    for (const r of rows) expect(r.classification, r.reasons.join()).toBe('invalid')
    expect(rows[0].reasons[0]).toMatch(/formula/)
  })
  it('a phone may start with +, but not with = or @', () => {
    const [a, b] = run(['E1,Ana,,,,+971501234567,,,,,', 'E2,Bo,,,,@1234567,,,,,'])
    expect(a.classification).toBe('new')
    expect(b.classification).toBe('invalid')
  })
  it('a row with a different number of cells than the header is invalid, not guessed at', () => {
    const rows = run(['E1,Ana,Female', 'E2,Bo,,,,,,,,,,,extra', 'E3,Cy,,,,,,,,,'])
    expect(rows.map(r => r.classification)).toEqual(['invalid', 'invalid', 'new'])
    expect(rows[0].reasons[0]).toMatch(/3 values but the header has 11/)
  })
  it('IDs that differ only in case or surrounding whitespace are the same ID: first wins, the rest are duplicates', () => {
    const rows = run(['E100,A,,,,,,,,,', ' e100 ,B,,,,,,,,,', 'E100 ,C,,,,,,,,,', 'E101,D,,,,,,,,,'])
    expect(rows.map(r => r.classification)).toEqual(['new', 'duplicate', 'duplicate', 'new'])
    expect(rows[1].reasons[0]).toMatch(/already appears on row 2/)
    expect(rows[0].key).toBe('e100')
  })
  it('an ID already in the directory is a duplicate even if the row has other problems; an invalid row does not claim its ID', () => {
    const rows = run(['E200,A,,,,notaphone,,,,,', 'E200,B,,,,,,,,,', 'E201,C,,,,,,,,,'], ['e201'])
    expect(rows.map(r => r.classification)).toEqual(['invalid', 'new', 'duplicate'])
    expect(rows[2].reasons[0]).toMatch(/already exists in the directory/)
  })
  it('a huge cell is rejected without echoing it', () => {
    const [r] = run([`E1,${'x'.repeat(100_000)},,,,,,,,,`])
    expect(r.classification).toBe('invalid')
    expect(r.reasons[0]).toMatch(/too long/)
    expect(JSON.stringify(r).length).toBeLessThan(2000)
  })
  it('keysOf lists the usable IDs once', () => {
    const r = readStaffCsv('employee_id,full_name\nA1,x\n a1 ,y\nbad id,z')
    if (!r.ok) throw new Error()
    expect(keysOf(analyseRows(r.rows, r.headerCount))).toEqual(['a1'])
  })
})

describe('field rules (shared by the form and the import)', () => {
  it('normalises names, case of email, gender words', () => {
    const n = normaliseStaff({ employeeId: ' E7 ', fullName: '  A   B ', gender: 'M', email: 'A@B.CO', grade: '07' })
    expect(n).toEqual({ ok: true, value: { employeeId: 'E7', fullName: 'A B', gender: 'male', department: null, grade: 7, phone: null, email: 'a@b.co', emergencyContact: null, joiningDate: null } })
  })
  it('validates only the fields it is asked about', () => {
    expect(validateStaff({ phone: 'abc', fullName: '' }, ['phone']).errors).toEqual({ phone: expect.any(String) })
  })
  it('rejects control characters and impossible dates', () => {
    expect(validateStaff({ fullName: 'a\u0007b' }, ['fullName']).errors.fullName).toMatch(/control/)
    expect(validateStaff({ joiningDate: '2026-02-30' }, ['joiningDate']).errors.joiningDate).toMatch(/does not exist/)
    expect(validateStaff({ joiningDate: '1800-01-01' }, ['joiningDate']).errors.joiningDate).toMatch(/outside/)
  })
})
