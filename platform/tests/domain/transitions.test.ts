import { describe, expect, it } from 'vitest'
import { BED_STATES, CLAIM_KINDS, RESERVATION_STATUSES, STAY_STATUSES } from '@/domain/enums'
import { BED_TRANSITIONS, CLAIM_KIND_TRANSITIONS, RESERVATION_TRANSITIONS, STAY_TRANSITIONS, canTransition } from '@/domain/transitions'

describe('state machines are total and closed', () => {
  const cases = [
    ['bed', BED_STATES, BED_TRANSITIONS],
    ['stay', STAY_STATUSES, STAY_TRANSITIONS],
    ['reservation', RESERVATION_STATUSES, RESERVATION_TRANSITIONS],
    ['claim', CLAIM_KINDS, CLAIM_KIND_TRANSITIONS],
  ] as const
  it.each(cases)('%s: every state has an entry and every target is a known state, never itself', (_name, states, machine) => {
    expect(Object.keys(machine).sort()).toEqual([...states].sort())
    for (const [from, tos] of Object.entries(machine)) {
      for (const to of tos) {
        expect(states as readonly string[]).toContain(to)
        expect(to).not.toBe(from)
      }
    }
  })
})

describe('the rules that matter', () => {
  it('a bed leaves Occupied only through cleaning or inspection, never straight to Available', () => {
    expect(canTransition(BED_TRANSITIONS, 'occupied', 'available')).toBe(false)
    expect(canTransition(BED_TRANSITIONS, 'needs_cleaning', 'available')).toBe(false)
    expect(canTransition(BED_TRANSITIONS, 'inspection_required', 'available')).toBe(true)
  })
  it('archived is final for beds, stays and reservations', () => {
    expect(BED_TRANSITIONS.archived).toEqual([])
    expect(STAY_TRANSITIONS.closed).toEqual([])
    expect(RESERVATION_TRANSITIONS.cancelled).toEqual([])
  })
  it('checkout and clearance are separate: Active goes to Checked out, never straight to Closed', () => {
    expect(canTransition(STAY_TRANSITIONS, 'active', 'closed')).toBe(false)
    expect(canTransition(STAY_TRANSITIONS, 'checked_out', 'closed')).toBe(true)
  })
  it('unknown states have no moves', () => {
    expect(canTransition(BED_TRANSITIONS, 'nope' as never, 'available')).toBe(false)
  })
})
