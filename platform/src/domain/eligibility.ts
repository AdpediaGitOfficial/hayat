/**
 * Eligibility rules (pure). GH-03 (the real matrix) is OPEN, so the rule set is a placeholder: a room gender policy
 * and an optional per-site minimum grade, both configurable. A failure that a Policy Approver may waive says so
 * (`exceptionable`); a left employee is never exceptionable.
 */
export type EligibilityKind = 'employment' | 'gender' | 'grade'

export interface EligibilityInput {
  staff: { employmentStatus: 'active' | 'left'; gender: 'male' | 'female' | null; grade: number | null }
  room: { name: string; genderPolicy: 'any' | 'male' | 'female' }
  site: { name: string; minGrade: number }
  genderStrict: boolean
  /** Kinds a Policy Approver has waived for this person (and site/request) right now. */
  exceptions: ReadonlySet<'gender' | 'grade'>
}

export interface EligibilityResult {
  ok: boolean
  reasons: string[]
  failed: EligibilityKind[]
  /** Exception kinds that were needed and used to pass. Callers record each use. */
  exceptionsUsed: ('gender' | 'grade')[]
  /** True when every failure is one a Policy Approver may waive. */
  exceptionable: boolean
}

export function evaluateEligibility(i: EligibilityInput): EligibilityResult {
  const reasons: string[] = []
  const failed: EligibilityKind[] = []
  const used: ('gender' | 'grade')[] = []

  if (i.staff.employmentStatus !== 'active') { reasons.push('Employment status is Left'); failed.push('employment') }

  if (i.genderStrict && i.room.genderPolicy !== 'any' && i.room.genderPolicy !== i.staff.gender) {
    if (i.exceptions.has('gender')) used.push('gender')
    else {
      reasons.push(i.staff.gender === null
        ? `${i.room.name} is ${i.room.genderPolicy}-only and the staff member's gender is not recorded`
        : `${i.room.name} is ${i.room.genderPolicy}-only (gender rule)`)
      failed.push('gender')
    }
  }

  if (i.site.minGrade > 0 && (i.staff.grade ?? -1) < i.site.minGrade) {
    if (i.exceptions.has('grade')) used.push('grade')
    else {
      reasons.push(i.staff.grade === null
        ? `${i.site.name} needs grade ${i.site.minGrade}+ and the staff member's grade is not recorded`
        : `${i.site.name} needs grade ${i.site.minGrade}+ (staff is grade ${i.staff.grade})`)
      failed.push('grade')
    }
  }

  return {
    ok: reasons.length === 0,
    reasons,
    failed,
    exceptionsUsed: reasons.length === 0 ? used : [],
    exceptionable: reasons.length > 0 && !failed.includes('employment'),
  }
}
