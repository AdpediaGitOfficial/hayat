/*
 * Ported from the prototype (prototype/src/domain/types.ts). These are the shapes the pure rules in rules.ts
 * operate on. They keep the prototype's CamelCase state names ('NeedsCleaning'); database rows use snake_case
 * ('needs_cleaning', see enums.ts). The repository layer (Stage 1+) maps rows to these shapes.
 */
import type { Capability, Role } from './enums'

export type { Role }
export type Cap = Capability
export type Gender = 'Male' | 'Female'
export type RoomGender = Gender | 'Any'
export type BedState = 'Available' | 'Occupied' | 'NeedsCleaning' | 'InspectionRequired' | 'Blocked' | 'UnderMaintenance' | 'Archived'
export type StayType = 'Permanent' | 'Contract' | 'Trainee'

export interface Site { id: string; code: string; name: string; kind: 'Villa' | 'Apartment'; minGrade: number }
export interface Building { id: string; siteId: string; name: string }
export interface Room { id: string; siteId: string; buildingId?: string; floor?: string; name: string; gender: RoomGender }
export interface Bed { id: string; code: string; roomId: string; siteId: string; state: BedState; reason?: string; since?: number; heldBy?: string }

export interface Staff {
  id: string; name: string; gender: Gender; dept: string; grade: number; phone: string; email?: string
  status: 'Active' | 'Left'; emergencyContact: string; joining: string; verified: boolean; loginActive: boolean
  exceptions: string[]; archived?: boolean; leftAt?: number; leftEffective?: string; source?: 'Manual' | 'CSV' | 'Seed'
}

export interface Persona {
  id: string; name: string; role: Role; caps: Cap[]; title: string; staffId?: string; sites: string[] | 'all'; vendor?: string
}

export interface Request {
  id: string; staffId: string; createdAt: number; arrival: string; end: string; stayType: StayType; note: string
  status: 'Submitted' | 'Approved' | 'Rejected' | 'Cancelled' | 'Waitlisted'
  submittedBy: string; reservationId?: string; decision?: { by: string; at: number; reason?: string }
  exceptionBy?: string; onBehalf?: boolean
}
export interface Reservation {
  id: string; bedId: string; staffId: string; from: string; to?: string; eta: number
  status: 'Reserved' | 'CheckedIn' | 'Expired' | 'Cancelled'
  createdAt: number; source: 'Request' | 'Offer' | 'Bulk' | 'Migrated'; requestId?: string; noShowExtended?: boolean; stayType: StayType
}
export interface Stay {
  id: string; bedId: string; staffId: string; start: string; end?: string; status: 'Active' | 'Ended'
  source: 'Standard' | 'Migrated' | 'Provisional'; stayType: StayType; endPending?: boolean; exitPending?: boolean
  checkoutRequested?: boolean; checkedOutAt?: number; emergencyId?: string; reviewDate?: string
}
export interface KeyRec { id: string; bedId: string; staffId: string; kind: 'Room key' | 'Locker key'; status: 'Issued' | 'Returned' | 'Lost'; at: number }

export interface WaitlistEntry {
  id: string; staffId: string; requestId?: string; createdAt: number; queueTs: number; expiresAt: number
  priority: string; declines: number; skipBeds: string[]; status: 'Waiting' | 'Offered' | 'Closed'; closeReason?: string
  remindersSent: number[]; gender: Gender
}
export interface Offer {
  id: string; entryId: string; staffId: string; bedId: string; createdAt: number
  deliveredAt?: number; deliveredVia?: 'viewed' | 'email' | 'offline'; expiresAt?: number
  status: 'Pending' | 'Accepted' | 'Declined' | 'Expired'; followUp?: boolean; acceptedBy?: string; acceptedOnBehalf?: boolean
}
export interface ClearanceItem { id: string; label: string; mandatory: boolean; owner: string; status: 'Open' | 'Done' | 'Waived' }
export interface Clearance {
  id: string; staffId: string; stayId?: string; openedAt: number; effective: string; reason: string
  items: ClearanceItem[]; status: 'Open' | 'Closed'; waiver?: { by: string; reason: string; evidence: string }
}
export interface CleaningTask { id: string; bedId: string; assignedTo?: string; status: 'Open' | 'Cleaned' | 'Passed'; cleanedBy?: string; createdAt: number }
export interface Emergency {
  id: string; stayId: string; staffId: string; bedId: string; initiatorId: string; initiatorRole: Role
  approverRole: 'AA' | 'PA'; reason: string; createdAt: number; status: 'Pending' | 'Approved' | 'Rejected'
  reminders: number; escalation: 0 | 1 | 2; decidedBy?: string; decisionReason?: string; decidedAt?: number
}
export interface Task { id: string; title: string; ownerRole: Role; due: number; done: boolean; ref?: string }
export interface Transfer {
  id: string; kind: 'Transfer' | 'Swap'; stayId: string; destBedId?: string; otherStayId?: string; reason: string
  requestedBy: string; createdAt: number; status: 'Submitted' | 'Approved' | 'Rejected' | 'Executed' | 'Failed'
  decidedBy?: string; note?: string
}
export interface Extension {
  id: string; stayId: string; newEnd: string; reason: string; createdAt: number; requestedBy: string
  status: 'Submitted' | 'Approved' | 'Rejected'; beyondPolicy: boolean; decidedBy?: string; note?: string
}
export interface Notification { id: string; at: number; toStaffId?: string; toRole?: Role | 'PA'; text: string; email?: boolean }
export interface AuditEntry { id: string; at: number; actor: string; action: string; detail: string }
export interface MigrationRow { empId: string; bedCode: string; start: string; end?: string; error?: string }
export interface MigrationBatch { id: string; preparedBy: string; rows: MigrationRow[]; status: 'Prepared' | 'SignedOff' | 'Imported'; signedBy?: string }
export interface Delegation { from: string; to: string; fromDate: string; toDate: string }
export interface Incident { id: string; kind: 'SOS' | 'Incident'; bedId?: string; staffId?: string; text: string; at: number; ackAt?: number; ackBy?: string; closed?: boolean }
export interface WorkOrder { id: string; bedId: string; title: string; status: 'Open' | 'In progress' | 'Resolved' | 'Verified'; assignee?: string; createdAt: number; resolvedBy?: string }

export interface Config {
  waitlistDays: number; waitlistReminderDays: number[]; offerHours: number; offerFollowUpHours: number
  emergencyDeadlineHours: number; emergencyEscalateAfter: number; slaBusinessDays: number; noShowHours: number
  sosAckMinutes: number; emergencyRelocationHours: number; overdueGraceDays: number; extensionPolicyDays: number; endReminderDays: number[]
  genderStrict: boolean; minGradeBySite: Record<string, number>; priorityCategories: string[]
}

export interface State {
  seq: number
  config: Config
  sites: Site[]; buildings: Building[]; rooms: Room[]; beds: Bed[]
  staff: Staff[]; requests: Request[]; reservations: Reservation[]; stays: Stay[]; keys: KeyRec[]
  waitlist: WaitlistEntry[]; offers: Offer[]; clearances: Clearance[]; cleaning: CleaningTask[]
  emergencies: Emergency[]; tasks: Task[]; transfers: Transfer[]; extensions: Extension[]
  notifications: Notification[]; audit: AuditEntry[]; migration?: MigrationBatch; delegations: Delegation[]
  incidents: Incident[]; workOrders: WorkOrder[]
}

export type Fail = { ok: false; reason: string; owner?: string; next?: string }
export type Ok<T = void> = { ok: true; msg?: string; data?: T }
export type Res<T = void> = Ok<T> | Fail
