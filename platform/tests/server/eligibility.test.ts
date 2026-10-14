import { describe, expect, it } from 'vitest'
import { evaluateEligibility, type EligibilityInput } from '@/domain/eligibility'
import { approvalClock, businessDaysElapsed, isUrgent } from '@/domain/approvals'

const base: EligibilityInput = {
  staff: { employmentStatus: 'active', gender: 'male', grade: 5 },
  room: { name: 'Room 1', genderPolicy: 'any' }, site: { name: 'Palm Villas', minGrade: 0 }, genderStrict: true, exceptions: new Set(),
}
type Over = Omit<Partial<EligibilityInput>, 'staff' | 'room' | 'site'> & { staff?: Partial<EligibilityInput['staff']>; room?: Partial<EligibilityInput['room']>; site?: Partial<EligibilityInput['site']> }
const mk = (o: Over): EligibilityInput =>
  ({ ...base, ...o, staff: { ...base.staff, ...o.staff }, room: { ...base.room, ...o.room }, site: { ...base.site, ...o.site } })

describe('evaluateEligibility', () => {
  it('passes with no rules in force (GH-03 open: nothing is invented)', () => {
    expect(evaluateEligibility(base)).toMatchObject({ ok: true, reasons: [], exceptionable: false })
  })
  it('gender: restricted room, wrong or unrecorded gender', () => {
    expect(evaluateEligibility(mk({ room: { genderPolicy: 'female' } }))).toMatchObject({ ok: false, failed: ['gender'], exceptionable: true })
    expect(evaluateEligibility(mk({ room: { genderPolicy: 'female' }, staff: { gender: 'female' } })).ok).toBe(true)
    expect(evaluateEligibility(mk({ room: { genderPolicy: 'female' }, staff: { gender: null } })).reasons[0]).toMatch(/not recorded/)
    expect(evaluateEligibility(mk({ room: { genderPolicy: 'female' }, genderStrict: false })).ok).toBe(true)
  })
  it('grade: below the site minimum, or unrecorded when a minimum exists', () => {
    expect(evaluateEligibility(mk({ site: { minGrade: 7 } }))).toMatchObject({ ok: false, failed: ['grade'] })
    expect(evaluateEligibility(mk({ site: { minGrade: 5 } })).ok).toBe(true)
    expect(evaluateEligibility(mk({ site: { minGrade: 7 }, staff: { grade: null } })).reasons[0]).toMatch(/not recorded/)
  })
  it('an exception waives only its own kind and reports its use', () => {
    const r = evaluateEligibility(mk({ room: { genderPolicy: 'female' }, site: { minGrade: 7 }, exceptions: new Set(['gender']) }))
    expect(r).toMatchObject({ ok: false, failed: ['grade'] })
    const both = evaluateEligibility(mk({ room: { genderPolicy: 'female' }, site: { minGrade: 7 }, exceptions: new Set(['gender', 'grade']) }))
    expect(both).toMatchObject({ ok: true, exceptionsUsed: ['gender', 'grade'] })
  })
  it('a left employee is never exceptionable, even with exceptions', () => {
    const r = evaluateEligibility(mk({ staff: { employmentStatus: 'left' }, exceptions: new Set(['gender', 'grade']) }))
    expect(r).toMatchObject({ ok: false, exceptionable: false, failed: ['employment'] })
  })
})

describe('approval clock', () => {
  const mon = Date.UTC(2026, 9, 12, 9) // Monday
  const H = 3600_000
  it('levels at 1, 2 and 3 business days; reminders only describe', () => {
    expect(approvalClock(mon, mon + 23 * H, 2)).toMatchObject({ level: 0, reminders: 0, label: 'Within SLA' })
    expect(approvalClock(mon, mon + 25 * H, 2)).toMatchObject({ level: 0, reminders: 1, label: 'Reminded' })
    expect(approvalClock(mon, mon + 49 * H, 2)).toMatchObject({ level: 1, label: 'Routed to backup' })
    expect(approvalClock(mon, mon + 73 * H, 2)).toMatchObject({ level: 2, label: 'Escalated' })
  })
  it('skips weekends and configured holidays', () => {
    const fri = Date.UTC(2026, 9, 16, 17)
    expect(businessDaysElapsed(fri, fri + 72 * H, { weekendDays: [0, 6], holidays: [] })).toBe(1)
    expect(businessDaysElapsed(fri, fri + 72 * H, { weekendDays: [0, 6], holidays: ['2026-10-19'] })).toBe(0)
    expect(businessDaysElapsed(fri, fri + 72 * H, { weekendDays: [5, 6], holidays: [] })).toBe(2) // a Fri/Sat weekend
  })
  it('urgent when the arrival falls inside the SLA window (D-46)', () => {
    expect(isUrgent('2026-10-14', mon, 2)).toBe(true)
    expect(isUrgent('2026-10-30', mon, 2)).toBe(false)
  })
})
