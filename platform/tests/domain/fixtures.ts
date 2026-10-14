import type { Bed, Config, Persona, Reservation, State, Staff, Stay } from '@/domain/types'

export const CFG: Config = {
  waitlistDays: 15, waitlistReminderDays: [3, 1], offerHours: 48, offerFollowUpHours: 24,
  emergencyDeadlineHours: 24, emergencyEscalateAfter: 2, slaBusinessDays: 2, noShowHours: 24,
  sosAckMinutes: 5, emergencyRelocationHours: 24, overdueGraceDays: 3, extensionPolicyDays: 30, endReminderDays: [14, 7, 1],
  genderStrict: true, minGradeBySite: {}, priorityCategories: [],
}

export const staff = (over: Partial<Staff> = {}): Staff => ({
  id: 'E1', name: 'Asha', gender: 'Female', dept: 'Front Office', grade: 4, phone: '0', status: 'Active',
  emergencyContact: '-', joining: '2026-01-01', verified: true, loginActive: true, exceptions: [], ...over,
})

export const stay = (over: Partial<Stay> = {}): Stay => ({
  id: 'ST1', bedId: 'b1', staffId: 'E1', start: '2026-10-01', status: 'Active', source: 'Standard', stayType: 'Contract', ...over,
})

export const reservation = (over: Partial<Reservation> = {}): Reservation => ({
  id: 'R1', bedId: 'b1', staffId: 'E1', from: '2026-10-20', to: '2026-10-31', eta: Date.UTC(2026, 9, 20, 12), status: 'Reserved',
  createdAt: 0, source: 'Request', stayType: 'Contract', ...over,
})

export const bed = (over: Partial<Bed> = {}): Bed => ({ id: 'b1', code: 'PV-V01-R1-A', roomId: 'r1', siteId: 'site1', state: 'Available', ...over })

/** A one-site, one-room, three-bed world. Override pieces per test. */
export function world(over: Partial<State> = {}): State {
  return {
    seq: 0, config: CFG,
    sites: [{ id: 'site1', code: 'PV', name: 'Palm Villas', kind: 'Villa', minGrade: 3 }],
    buildings: [{ id: 'bld1', siteId: 'site1', name: 'Villa 01' }],
    rooms: [{ id: 'r1', siteId: 'site1', buildingId: 'bld1', name: 'Room 1', gender: 'Female' }],
    beds: [
      bed({ id: 'b1', code: 'PV-V01-R1-A' }),
      bed({ id: 'b2', code: 'PV-V01-R1-B' }),
      bed({ id: 'b3', code: 'PV-V01-R1-C', state: 'NeedsCleaning' }),
    ],
    staff: [staff()], requests: [], reservations: [], stays: [], keys: [], waitlist: [], offers: [], clearances: [], cleaning: [],
    emergencies: [], tasks: [], transfers: [], extensions: [], notifications: [], audit: [], delegations: [], incidents: [], workOrders: [],
    ...over,
  }
}

export const persona = (over: Partial<Persona> = {}): Persona => ({
  id: 'p1', name: 'Admin', role: 'AA', caps: [], title: 'Accommodation Admin', sites: ['site1'], ...over,
})
