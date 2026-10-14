/**
 * Staff CSV import rules (D-34, SRS section 7 and Appendix A, AT-004/005, NFR-06). Pure: reads text, never touches a database.
 * The commands add the one database fact the rules need, the set of employee IDs that already exist.
 *
 * Reading the file:   readStaffCsv(text)        -> rows keyed by canonical column, or one clear error for the whole file
 * Checking each row:  analyseRows(rows)         -> field errors and warnings, plus the normalised employee ID
 * Deciding outcomes:  classifyRows(drafts, set) -> new / duplicate / invalid for every row
 */
import { CsvSyntaxError, parseCsv } from './csv'
import { validateStaff, type RawStaff, type StaffValues } from './fields'

export const MAX_ROWS = 5000
export const MAX_COLUMNS = 40
export const MAX_FILE_CHARS = 2_000_000
/** Cells are shortened before they are stored or echoed; validation always sees the full text. */
const STORED_CELL_CHARS = 300

export const CANONICAL_COLUMNS = [
  'employee_id', 'full_name', 'gender', 'department', 'grade', 'phone', 'email', 'joining_date', 'employment_status',
  'emergency_contact', 'emergency_contact_name', 'emergency_contact_phone',
] as const
export type Column = (typeof CANONICAL_COLUMNS)[number]

/** The SRS Appendix A template, in its own wording. */
export const TEMPLATE_HEADER = 'employee_id,full_name,gender,department,designation_or_grade,phone,email_or_username,joining_date,employment_status,emergency_contact_name,emergency_contact_phone'
export const TEMPLATE_EXAMPLE = 'E3001,Hassan Ali,Male,Culinary,2,+971501110001,hassan@example.com,2026-10-12,Active,Amina Ali,+971501110099'

const ALIASES: Record<string, Column> = {
  employee_id: 'employee_id', employeeid: 'employee_id', employee_no: 'employee_id', employee_number: 'employee_id', emp_id: 'employee_id', emp_no: 'employee_id', staff_id: 'employee_id', staff_no: 'employee_id', id: 'employee_id',
  full_name: 'full_name', name: 'full_name', employee_name: 'full_name', staff_name: 'full_name', fullname: 'full_name',
  gender: 'gender', sex: 'gender',
  department: 'department', dept: 'department',
  grade: 'grade', designation_or_grade: 'grade', designation: 'grade', grade_level: 'grade',
  phone: 'phone', mobile: 'phone', phone_number: 'phone', mobile_number: 'phone', contact_number: 'phone',
  email: 'email', email_address: 'email', email_or_username: 'email',
  joining_date: 'joining_date', join_date: 'joining_date', date_of_joining: 'joining_date', doj: 'joining_date', start_date: 'joining_date',
  employment_status: 'employment_status', status: 'employment_status',
  emergency_contact: 'emergency_contact', emergency_contact_name: 'emergency_contact_name', emergency_contact_phone: 'emergency_contact_phone',
}
/** Columns of our own rejected-rows file: recognised and quietly skipped when that file is uploaded again after fixing. */
const SILENT = new Set(['row', 'reason'])

export const normaliseHeader = (h: string): string => h.replace(/^﻿/, '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')

export interface ReadRow {
  /** Spreadsheet row number: the header is row 1, the first record is row 2. */
  rowNo: number
  cells: Partial<Record<Column, string>>
  cellCount: number
}
export type ReadResult =
  | { ok: true; rows: ReadRow[]; headerCount: number; ignoredColumns: string[]; blankSkipped: number }
  | { ok: false; reason: string; next: string }

const refuse = (reason: string, next = 'Fix the file and upload it again'): ReadResult => ({ ok: false, reason, next })

export function readStaffCsv(text: string): ReadResult {
  if (text.trim() === '') return refuse('The file is empty', 'Choose a CSV file that has a header row and at least one staff row')
  // eslint-disable-next-line no-control-regex
  if (/\u0000/.test(text)) return refuse('This is not a text CSV file (it contains binary data)', 'Save the sheet as "CSV UTF-8" and upload that')
  if (text.includes('�')) return refuse('The file is not valid UTF-8 text, so names could be garbled', 'In Excel use Save As, "CSV UTF-8 (Comma delimited)"')
  let records: string[][]
  try { records = parseCsv(text) } catch (e) {
    if (e instanceof CsvSyntaxError) return refuse(`The file is not valid CSV: ${e.message}`, 'Check the quotes around that value, then upload again')
    throw e
  }
  if (records.length === 0 || records[0].every(h => h.trim() === '')) return refuse('The file has no header row', `Start the file with a header such as ${TEMPLATE_HEADER}`)

  const header = records[0]
  if (header.length > MAX_COLUMNS) return refuse(`The file has ${header.length} columns; the limit is ${MAX_COLUMNS}`)
  const columnOf: (Column | null)[] = []
  const ignored: string[] = []
  const claimedBy = new Map<Column, string>()
  for (const raw of header) {
    const norm = normaliseHeader(raw)
    const col = Object.hasOwn(ALIASES, norm) ? ALIASES[norm] : undefined
    if (!col) {
      columnOf.push(null)
      if (norm && !SILENT.has(norm)) ignored.push(raw.trim().slice(0, 40))
      continue
    }
    const prev = claimedBy.get(col)
    if (prev !== undefined) return refuse(`Two columns mean the same thing: “${prev.slice(0, 40)}” and “${raw.trim().slice(0, 40)}” are both ${col}`, 'Keep one of them')
    claimedBy.set(col, raw.trim())
    columnOf.push(col)
  }
  const missing = (['employee_id', 'full_name'] as const).filter(c => !claimedBy.has(c))
  if (missing.length) {
    const onlyOne = header.length === 1 && /[;\t|]/.test(header[0])
    return refuse(
      `The header row has no ${missing.join(' or ')} column${onlyOne ? '. This looks like a file separated by semicolons or tabs' : ''}`,
      onlyOne ? 'Save it with commas between the values (CSV UTF-8)' : `Start the file with a header such as ${TEMPLATE_HEADER}`,
    )
  }

  const rows: ReadRow[] = []
  let blankSkipped = 0
  const data = records.slice(1)
  for (let i = 0; i < data.length; i++) {
    const rec = data[i]
    if (rec.every(c => c.trim() === '')) { blankSkipped++; continue }
    const cells: Partial<Record<Column, string>> = {}
    columnOf.forEach((col, idx) => { if (col && idx < rec.length) cells[col] = rec[idx].trim() })
    rows.push({ rowNo: i + 2, cells, cellCount: rec.length })
    if (rows.length > MAX_ROWS) return refuse(`The file has more than ${MAX_ROWS} staff rows`, `Split it into files of at most ${MAX_ROWS} rows`)
  }
  if (rows.length === 0) return refuse('The file has a header but no staff rows', 'Add the staff to import under the header row')
  return { ok: true, rows, headerCount: header.length, ignoredColumns: ignored, blankSkipped }
}

/* ---------------- per-row checks ---------------- */

export interface Draft {
  rowNo: number
  /** Cells shortened for storage and display. */
  raw: Record<string, string>
  values?: StaffValues
  /** lower(btrim(employee_id)) when the employee ID cell is usable. */
  key: string | null
  errors: string[]
  warnings: string[]
}

const shorten = (v: string) => (v.length > STORED_CELL_CHARS ? v.slice(0, STORED_CELL_CHARS) + '…' : v)

export function analyseRows(rows: readonly ReadRow[], headerCount: number): Draft[] {
  return rows.map(r => {
    const raw: Record<string, string> = {}
    for (const [k, v] of Object.entries(r.cells)) raw[k] = shorten(v)
    const c = r.cells
    const errors: string[] = []
    const warnings: string[] = []

    // A row with a different number of cells than the header is shifted: nothing in it can be trusted.
    if (r.cellCount !== headerCount) {
      errors.push(`The row has ${r.cellCount} values but the header has ${headerCount}. A comma inside an unquoted value shifts the columns`)
      return { rowNo: r.rowNo, raw, key: null, errors, warnings }
    }

    const emergency = [c.emergency_contact, c.emergency_contact_name, c.emergency_contact_phone].filter(x => x && x.trim()).join(' · ')
    const input: RawStaff = {
      employeeId: c.employee_id, fullName: c.full_name, gender: c.gender, department: c.department, grade: c.grade,
      phone: c.phone, email: c.email, emergencyContact: emergency, joiningDate: c.joining_date,
    }
    const { values, errors: fieldErrors } = validateStaff(input)
    for (const msg of Object.values(fieldErrors)) errors.push(msg)

    const status = (c.employment_status ?? '').trim().toLowerCase()
    if (status === 'left') errors.push('Employment status is Left. People are imported as Active; Mark as Left is done from the staff record')
    else if (status !== '' && status !== 'active') errors.push(`Employment status “${shorten(c.employment_status ?? '').slice(0, 24)}” is not recognised. Use Active or leave it empty`)

    const key = fieldErrors.employeeId ? null : (values.employeeId as string).toLowerCase()
    if (errors.length === 0) {
      if (values.gender === null) warnings.push('No gender: gender-based eligibility cannot be checked for this person')
      if (values.grade === null) warnings.push('No grade: grade-based entitlement cannot be checked for this person')
      if (values.emergencyContact === null) warnings.push('No emergency contact (confirm whether it is required)')
    }
    return { rowNo: r.rowNo, raw, values: errors.length === 0 ? (values as StaffValues) : undefined, key, errors, warnings }
  })
}

/* ---------------- outcome ---------------- */

export type Classification = 'new' | 'duplicate' | 'invalid'
export interface Analysed {
  rowNo: number
  classification: Classification
  reasons: string[]
  warnings: string[]
  key: string | null
  raw: Record<string, string>
  values?: StaffValues
}

/** The employee IDs a file talks about, so the caller can ask the database which of them already exist. */
export const keysOf = (drafts: readonly Draft[]): string[] => [...new Set(drafts.flatMap(d => (d.key ? [d.key] : [])))]

/**
 * Decides every row. A duplicate is an employee ID that already exists in the directory (archived or not) or that an
 * earlier row of this file already claims; nothing is ever merged. A row that fails its own checks does not claim its ID.
 */
export function classifyRows(drafts: readonly Draft[], existingKeys: ReadonlySet<string>): Analysed[] {
  const firstRow = new Map<string, number>()
  return drafts.map(d => {
    const dup: string[] = []
    if (d.key) {
      const id = d.raw.employee_id ?? d.key
      if (existingKeys.has(d.key)) dup.push(`Employee ID ${shortId(id)} already exists in the directory. Records are never merged automatically`)
      else if (firstRow.has(d.key)) dup.push(`Employee ID ${shortId(id)} already appears on row ${firstRow.get(d.key)} of this file`)
    }
    if (dup.length) return { rowNo: d.rowNo, classification: 'duplicate' as const, reasons: [...dup, ...d.errors], warnings: [], key: d.key, raw: d.raw }
    if (d.errors.length) return { rowNo: d.rowNo, classification: 'invalid' as const, reasons: d.errors, warnings: [], key: d.key, raw: d.raw }
    firstRow.set(d.key!, d.rowNo)
    return { rowNo: d.rowNo, classification: 'new' as const, reasons: [], warnings: d.warnings, key: d.key, raw: d.raw, values: d.values }
  })
}

const shortId = (s: string) => (s.length > 32 ? s.slice(0, 32) + '…' : s)
