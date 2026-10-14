/** What the audit trail records about a staff profile. Contact details are noted as changed, never copied into the log. */
import type { StaffValues } from './fields'

const CONTACT: readonly (keyof StaffValues)[] = ['phone', 'email', 'emergencyContact']

/** The audit-safe view of some staff values: contact fields become '[set]' / '[cleared]'. */
export function auditValues(v: Partial<StaffValues>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, val] of Object.entries(v)) {
    out[k] = CONTACT.includes(k as keyof StaffValues) ? (val === null || val === undefined ? '[empty]' : '[set]') : val
  }
  return out
}
