export type Role = 'SA' | 'AA' | 'Rec' | 'Res' | 'MC' | 'Tech' | 'Vend' | 'Sec' | 'Mgr' | 'Aud'
export type Cap =
  | 'Housekeeping' | 'FinalInspection' | 'EmergencyCheckin' | 'BuildingCreation' | 'NightKeys'
  | 'BackupApprover' | 'PolicyApprover' | 'OutageExport' | 'StaffMaster' | 'ReportExport'
export type Gender = 'Male' | 'Female'
export type RoomGender = Gender | 'Any'
export type BedState = 'Available' | 'Occupied' | 'NeedsCleaning' | 'InspectionRequired' | 'Blocked' | 'UnderMaintenance' | 'Archived'
export type StayType = 'Permanent' | 'Contract' | 'Trainee'

export interface Site { id: string; code: string; name: string; kind: 'Villa' | 'Apartment'; minGrade: number }
export interface Building { id: string; siteId: string; name: string; archived?: boolean; blocked?: Hold }
export interface Hold { reason: string; at: number; by: string }
export interface Room { id: string; siteId: string; buildingId?: string; floor?: string; name: string; gender: RoomGender; archived?: boolean; blocked?: Hold }
export interface BedBlock { id: string; from: string; to?: string; reason: string; by: string }
export interface Bed { id: string; code: string; roomId: string; siteId: string; state: BedState; reason?: string; since?: number; heldBy?: string; blocks?: BedBlock[] }

export interface Staff {
  id: string; name: string; gender: Gender; dept: string; grade: number; phone: string; email?: string
  status: 'Active' | 'Left'; emergencyContact: string; joining: string; verified: boolean; loginActive: boolean
  exceptions: string[]; archived?: boolean; leftAt?: number; leftEffective?: string; source?: 'Manual' | 'CSV' | 'Seed'
  hasPhoto?: boolean; rehiredAt?: number
}

export interface Persona {
  id: string; name: string; role: Role; caps: Cap[]; title: string; staffId?: string; sites: string[] | 'all'; vendor?: string
  /** Filled in by actingAs(): roles borrowed through an active delegation, and whether the login is revoked. */
  extraRoles?: Role[]; delegatedFrom?: string[]; revoked?: boolean
}

export interface Request {
  id: string; staffId: string; createdAt: number; arrival: string; end: string; stayType: StayType; note: string
  status: 'Submitted' | 'ChangesRequested' | 'Approved' | 'Rejected' | 'Cancelled' | 'Waitlisted'
  submittedBy: string; reservationId?: string; decision?: { by: string; at: number; reason?: string }
  exceptionBy?: string; onBehalf?: boolean; changeNote?: string
  revisions?: { at: number; arrival: string; end: string; note: string; by: string }[]
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
  checkoutRequestedAt?: number; checkoutAckAt?: number; checkoutAckBy?: string; checkoutEscalated?: boolean
  remindersSent?: number[]; overdueNotified?: boolean; escalatedNotified?: boolean
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
export type EmailStatus = 'queued' | 'retrying' | 'sent' | 'delivered' | 'failed'
export interface Notification {
  id: string; at: number; toStaffId?: string; toRole?: Role | 'PA'; text: string; email?: boolean
  emailStatus?: EmailStatus; attempts?: number; nextAttemptAt?: number; lastError?: string; sentAt?: number
  dedupeKey?: string; ref?: { kind: 'offer'; id: string }; critical?: boolean
}
export interface AuditEntry { id: string; at: number; actor: string; action: string; detail: string }
export interface MigrationRow { empId: string; bedCode: string; start: string; end?: string; error?: string }
export interface MigrationBatch { id: string; preparedBy: string; rows: MigrationRow[]; status: 'Prepared' | 'SignedOff' | 'Imported'; signedBy?: string }
export interface Delegation { from: string; to: string; fromDate: string; toDate: string }
export interface Incident { id: string; kind: 'SOS' | 'Incident'; bedId?: string; staffId?: string; text: string; at: number; ackAt?: number; ackBy?: string; closed?: boolean; escalation?: 0 | 1 | 2; closeNote?: string }
export interface WorkOrder { id: string; bedId: string; title: string; status: 'Open' | 'In progress' | 'Resolved' | 'Verified'; assignee?: string; createdAt: number; resolvedBy?: string }

export interface Visitor {
  id: string; name: string; hostStaffId: string; purpose: string; siteId: string; from: number; to: number
  status: 'Pre-registered' | 'Approved' | 'Checked in' | 'Checked out' | 'Denied' | 'Walk-in pending'
  requiresApproval: boolean; approvedBy?: string; denyReason?: string; checkedInAt?: number; checkedOutAt?: number; createdBy: string; overstayNotified?: boolean
}
export interface Vendor { id: string; name: string }
export interface Contract { id: string; vendorId: string; from: string; to: string; status: 'Active' | 'Suspended' | 'Terminated'; docsValidUntil: string }
export interface ContractorVisit {
  id: string; vendorId: string; workOrderId: string; siteId: string; from: number; to: number; escort?: string; workers: string[]
  status: 'Scheduled' | 'Gate pass valid' | 'Checked in' | 'Checked out' | 'Denied' | 'Revoked'; denyReason?: string
  checkedInAt?: number; checkedOutAt?: number; overstayNotified?: boolean
}
export interface OfflineEvent {
  id: string; kind: 'arrival' | 'departure'; staffId: string; bedCode: string; at: number; loggedBy: string
  status: 'Pending review' | 'Applied' | 'Conflict' | 'Dismissed'; conflict?: string; reviewedBy?: string; reviewedAt?: number; note?: string
}
export interface Outage { declaredAt: number; declaredBy: string; restoredAt?: number; restoredBy?: string }
export interface PermissionChange {
  id: string; kind: 'grant' | 'revoke' | 'role' | 'scope'; targetPersonaId: string; cap?: Cap; role?: Role; sites?: string[] | 'all'
  reason: string; expires?: string; requestedBy: string; requestedByPersonaId: string; at: number
  status: 'Pending' | 'Applied' | 'Rejected'; decidedBy?: string; decidedAt?: number; decisionNote?: string
}
export interface Override { addCaps: { cap: Cap; expires?: string; changeId: string }[]; removeCaps: Cap[]; role?: Role; sites?: string[] | 'all' }
export interface Account { active: boolean; mustChange?: boolean; credentialIssuedAt?: number; deactivatedReason?: string }
export interface ExportRecord { id: string; at: number; by: string; kind: string; rows: number; scope: string }

export interface Config {
  waitlistDays: number; waitlistReminderDays: number[]; offerHours: number; offerFollowUpHours: number
  emergencyDeadlineHours: number; emergencyEscalateAfter: number; slaBusinessDays: number; noShowHours: number
  sosAckMinutes: number; emergencyRelocationHours: number; overdueGraceDays: number; extensionPolicyDays: number; endReminderDays: number[]
  genderStrict: boolean; minGradeBySite: Record<string, number>; priorityCategories: string[]
  sosEscalationMinutes: number; notificationDedupeMinutes: number; emailBackoffMinutes: number[]; emailDeliveredAfterSeconds: number
  // Visitor policy is OPEN (GH-10): placeholders
  visitorHours: { open: string; close: string }; visitorOvernight: boolean; residentVisitorRequests: boolean
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
  visitors: Visitor[]; vendors: Vendor[]; contracts: Contract[]; contractorVisits: ContractorVisit[]
  outage?: Outage; offlineEvents: OfflineEvent[]
  changes: PermissionChange[]; overrides: Record<string, Override>; accounts: Record<string, Account>
  exports: ExportRecord[]; emailProviderUp: boolean
}

export type Fail = { ok: false; reason: string; owner?: string; next?: string }
export type Ok<T = void> = { ok: true; msg?: string; data?: T }
export type Res<T = void> = Ok<T> | Fail
