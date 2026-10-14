import type { Capability, Role } from './enums'

export const ROLE_LABEL: Record<Role, string> = {
  SA: 'Super Admin', AA: 'Accommodation Admin', Rec: 'Reception / Officer', Res: 'Resident', MC: 'Maintenance Coordinator',
  Tech: 'Technician', Vend: 'Vendor / Contractor', Sec: 'Security', Mgr: 'Read-only Manager', Aud: 'Auditor',
}
export const CAP_LABEL: Record<Capability, string> = {
  Housekeeping: 'Housekeeping', FinalInspection: 'Final Inspection', EmergencyCheckin: 'Emergency Check-in', BuildingCreation: 'Building Creation',
  NightKeys: 'Night Keys', BackupApprover: 'Backup Approver', PolicyApprover: 'Policy Approver', OutageExport: 'Outage Export', StaffMaster: 'Staff Master',
}
