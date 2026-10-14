/**
 * Staff profile field rules, shared by the create/update commands and the CSV import so a value is valid in one place
 * exactly when it is valid in the other (D-33 minimum profile). Pure functions, no I/O.
 *
 * Required: employee ID and full name. Everything else is optional until the eligibility policy says otherwise (GH-03 is OPEN),
 * so a missing gender, grade or emergency contact is reported as a warning by the import, never as an error.
 */
import { startsLikeFormula } from './csv'

export const FIELD_NAMES = ['employeeId', 'fullName', 'gender', 'department', 'grade', 'phone', 'email', 'emergencyContact', 'joiningDate'] as const
export type FieldName = (typeof FIELD_NAMES)[number]

export const LIMITS = { employeeId: 32, fullName: 120, department: 80, phone: 24, email: 254, emergencyContact: 200 } as const

/** What a caller may hand in: strings from a form or CSV cell, a number for grade, or nothing. */
export type RawValue = string | number | null | undefined
export type RawStaff = Partial<Record<FieldName, RawValue>>

export interface StaffValues {
  employeeId: string
  fullName: string
  gender: 'male' | 'female' | null
  department: string | null
  grade: number | null
  phone: string | null
  email: string | null
  emergencyContact: string | null
  joiningDate: string | null
}

export type FieldErrors = Partial<Record<FieldName, string>>

/** Short, safe echo of a bad value for an error message (never the whole of a huge cell). */
const echo = (v: string) => `“${v.length > 24 ? v.slice(0, 24) + '…' : v}”`
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/

const asText = (v: RawValue): string => (v === null || v === undefined ? '' : String(v)).trim()

type Check<T> = { ok: true; value: T } | { ok: false; error: string }
const good = <T,>(value: T): Check<T> => ({ ok: true, value })
const bad = (error: string): Check<never> => ({ ok: false, error })

function formulaError(v: string, label: string): string {
  return `${label} starts with “${v[0]}”. Values starting with = + - or @ are not accepted because a spreadsheet could run them as a formula`
}

function checkText(label: string, raw: RawValue, max: number, o: { required?: boolean; collapse?: boolean } = {}): Check<string | null> {
  let v = asText(raw)
  if (o.collapse) v = v.replace(/\s+/g, ' ')
  if (v === '') return o.required ? bad(`${label} is required`) : good(null)
  if (CONTROL.test(v)) return bad(`${label} contains a control character`)
  if (v.length > max) return bad(`${label} is too long (${v.length} characters; the limit is ${max})`)
  if (startsLikeFormula(v)) return bad(formulaError(v, label))
  return good(v)
}

export const normaliseEmployeeId = (v: string): string => v.trim().toLowerCase()

const RULES: { [K in FieldName]: (raw: RawValue) => Check<StaffValues[K]> } = {
  employeeId(raw) {
    const v = asText(raw)
    if (v === '') return bad('Employee ID is required')
    if (v.length > LIMITS.employeeId) return bad(`Employee ID is too long (${v.length} characters; the limit is ${LIMITS.employeeId})`)
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(v)) return bad(`Employee ID ${echo(v)} must start with a letter or digit and use only letters, digits and . _ / - (no spaces)`)
    return good(v)
  },
  fullName(raw) {
    const r = checkText('Full name', raw, LIMITS.fullName, { required: true, collapse: true })
    return r.ok ? good(r.value as string) : r
  },
  gender(raw) {
    const v = asText(raw).toLowerCase()
    if (v === '') return good(null)
    if (v === 'male' || v === 'm') return good('male')
    if (v === 'female' || v === 'f') return good('female')
    return bad(`Gender ${echo(asText(raw))} is not recognised. Use Male or Female`)
  },
  department(raw) { return checkText('Department', raw, LIMITS.department, { collapse: true }) },
  grade(raw) {
    const v = asText(raw)
    if (v === '') return good(null)
    if (!/^\d{1,3}$/.test(v)) return bad(`Grade ${echo(v)} must be a whole number, 0 or more`)
    return good(Number(v))
  },
  phone(raw) {
    const v = asText(raw)
    if (v === '') return good(null)
    if (CONTROL.test(v)) return bad('Phone contains a control character')
    if (v.length > LIMITS.phone) return bad(`Phone is too long (the limit is ${LIMITS.phone} characters)`)
    if (/^[=@]/.test(v)) return bad(formulaError(v, 'Phone'))
    if (!/^\+?[0-9][0-9 ()./-]*$/.test(v)) return bad(`Phone ${echo(v)} may only contain digits, spaces, ( ) . / - and a leading +`)
    const digits = v.replace(/\D/g, '').length
    if (digits < 6 || digits > 15) return bad(`Phone ${echo(v)} must have 6 to 15 digits`)
    return good(v)
  },
  email(raw) {
    const r = checkText('Email', raw, LIMITS.email)
    if (!r.ok || r.value === null) return r
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(r.value)) return bad(`Email ${echo(r.value)} is not a valid address. Leave it empty if there is none (the username defaults to the employee ID)`)
    return good(r.value.toLowerCase())
  },
  emergencyContact(raw) { return checkText('Emergency contact', raw, LIMITS.emergencyContact, { collapse: true }) },
  joiningDate(raw) {
    const v = asText(raw)
    if (v === '') return good(null)
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v)
    if (!m) return bad(`Joining date ${echo(v)} is not a date. Use YYYY-MM-DD`)
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
    const dt = new Date(Date.UTC(y, mo - 1, d))
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return bad(`Joining date ${echo(v)} does not exist`)
    if (y < 1950 || y > 2100) return bad(`Joining date ${echo(v)} is outside 1950 to 2100`)
    return good(v)
  },
}

/**
 * Validates and normalises the named fields (default: all of them). Missing optional fields come back as null.
 * `only` lets an update check just the fields it was given, so an old value that predates a rule never blocks an unrelated edit.
 */
export function validateStaff(raw: RawStaff, only: readonly FieldName[] = FIELD_NAMES): { values: Partial<StaffValues>; errors: FieldErrors } {
  const values: Record<string, unknown> = {}
  const errors: FieldErrors = {}
  for (const f of only) {
    const r = (RULES[f] as (v: RawValue) => Check<unknown>)(raw[f])
    if (r.ok) values[f] = r.value
    else errors[f] = r.error
  }
  return { values: values as Partial<StaffValues>, errors }
}

export function normaliseStaff(raw: RawStaff): { ok: true; value: StaffValues } | { ok: false; errors: FieldErrors } {
  const { values, errors } = validateStaff(raw)
  if (Object.keys(errors).length) return { ok: false, errors }
  return { ok: true, value: values as StaffValues }
}
