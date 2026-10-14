/* Staff CSV import: pure parsing and validation, so the preview commits nothing (AT-004) and the result of a partial import is reproducible (AT-005).
   Guards against spreadsheet formula injection (NFR-06). */
import type { Gender, Staff } from './types'

export type NewStaff = Omit<Staff, 'status' | 'loginActive' | 'exceptions' | 'verified' | 'source'>
export type CsvRow = { line: number; raw: string[]; status: 'accepted' | 'duplicate' | 'invalid' | 'warning'; why: string; rec?: NewStaff }

export const STAFF_CSV_HEADER = 'employee_id,full_name,gender,department,designation_or_grade,phone,email_or_username,joining_date,employment_status,emergency_contact_name,emergency_contact_phone'

export function parseStaffCsv(text: string, existingIds: string[]): CsvRow[] {
  const lines = text.split(/\r?\n/).filter(l => l.trim())
  const seen = new Set(existingIds.map(x => x.trim().toLowerCase()))
  return lines.slice(1).map((l, i) => {
    const line = i + 2
    const c = l.split(',').map(x => x.trim())
    const [id, name, gender, dept, grade, phone, email, joining, , ecn, ecp] = c
    const bad = c.find(x => /^[=+\-@]/.test(x) && !/^\+\d+$/.test(x))
    if (bad) return { line, raw: c, status: 'invalid' as const, why: `Formula injection guard: “${bad.slice(0, 16)}…” starts with =, +, - or @` }
    if (!id || !name) return { line, raw: c, status: 'invalid' as const, why: 'Employee ID and full name are required' }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(joining ?? '') || Number.isNaN(Date.parse(joining))) return { line, raw: c, status: 'invalid' as const, why: `Joining date “${joining}” is not a valid date (use YYYY-MM-DD)` }
    if (seen.has(id.trim().toLowerCase())) return { line, raw: c, status: 'duplicate' as const, why: `Employee ID ${id} already exists${existingIds.some(x => x.trim().toLowerCase() === id.trim().toLowerCase()) ? '' : ' earlier in this file'}. Never auto-merged` }
    seen.add(id.trim().toLowerCase())
    const rec: NewStaff = { id, name, gender: (gender === 'Female' ? 'Female' : 'Male') as Gender, dept, grade: +grade || 1, phone, email: email || undefined, emergencyContact: ecn ? `${ecn} · ${ecp}` : '', joining }
    return { line, raw: c, status: ecn ? 'accepted' as const : 'warning' as const, why: ecn ? 'OK' : 'No emergency contact (confirm whether required)', rec }
  })
}
export const importable = (rows: CsvRow[]) => rows.filter(r => r.status === 'accepted' || r.status === 'warning')
export const rejectedCsv = (rows: CsvRow[]) =>
  'row,reason\n' + rows.filter(r => r.status === 'invalid' || r.status === 'duplicate').map(r => `${r.line},"${r.why.replace(/"/g, "'")}"`).join('\n')
