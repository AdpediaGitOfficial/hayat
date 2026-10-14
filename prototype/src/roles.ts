import type { Cap, Persona, Role } from './domain/types'
import type { IconName } from './ui/icons'

export const ROLE_LABEL: Record<Role, string> = {
  SA: 'Super Admin', AA: 'Accommodation Admin', Rec: 'Reception / Officer', Res: 'Resident', MC: 'Maintenance Coordinator',
  Tech: 'Technician', Vend: 'Vendor / Contractor', Sec: 'Security', Mgr: 'Read-only Manager', Aud: 'Auditor',
}
export const CAP_LABEL: Record<Cap, string> = {
  Housekeeping: 'Housekeeping', FinalInspection: 'Final Inspection', EmergencyCheckin: 'Emergency Check-in', BuildingCreation: 'Building Creation',
  NightKeys: 'Night Keys', BackupApprover: 'Backup Approver', PolicyApprover: 'Policy Approver', OutageExport: 'Outage Export', StaffMaster: 'Staff Master / HR', ReportExport: 'Report export',
}

/** Demo personas. Resident personas each sit at a different point of the accommodation journey (D-94). */
export const PERSONAS: Persona[] = [
  { id: 'p-aa', name: 'Anita Rao', role: 'AA', caps: ['FinalInspection', 'EmergencyCheckin', 'BuildingCreation'], title: 'Accommodation Admin', staffId: 'E9001', sites: ['PV', 'MA'] },
  { id: 'p-aa2', name: 'Kavita Nair', role: 'AA', caps: [], title: 'Accommodation Admin · Lakeview only', staffId: 'E9011', sites: ['LV'] },
  { id: 'p-pa', name: 'Suresh Menon', role: 'AA', caps: ['PolicyApprover'], title: 'Accommodation Manager · Policy Approver', staffId: 'E9003', sites: ['PV', 'MA', 'LV'] },
  { id: 'p-backup', name: 'Naveen Kapoor', role: 'AA', caps: ['BackupApprover'], title: 'Assistant Manager · Backup Approver', staffId: 'E9004', sites: ['PV', 'MA', 'LV'] },
  { id: 'p-sa', name: 'Vikram Shah', role: 'SA', caps: [], title: 'Super Admin (IT)', staffId: 'E9005', sites: 'all' },
  { id: 'p-sa2', name: 'Meghna Rao', role: 'SA', caps: [], title: 'Super Admin (IT, second)', staffId: 'E9012', sites: 'all' },
  { id: 'p-rec', name: 'Rohan Das', role: 'Rec', caps: ['EmergencyCheckin', 'FinalInspection', 'OutageExport'], title: 'Reception Officer', staffId: 'E9002', sites: ['PV', 'MA', 'LV'] },
  { id: 'p-res-staying', name: 'Rahul Menon', role: 'Res', caps: [], title: 'Resident · staying', staffId: 'E1007', sites: [] },
  { id: 'p-res-reserved', name: 'Ayesha Khan', role: 'Res', caps: [], title: 'Resident · reserved', staffId: 'E1012', sites: [] },
  { id: 'p-res-applied', name: 'Kiran Patel', role: 'Res', caps: [], title: 'Resident · applied', staffId: 'E1030', sites: [] },
  { id: 'p-res-waitlist', name: 'Neha Sharma', role: 'Res', caps: [], title: 'Resident · waitlisted', staffId: 'E1033', sites: [] },
  { id: 'p-res-offer', name: 'Omar Farouk', role: 'Res', caps: [], title: 'Resident · bed offered', staffId: 'E1036', sites: [] },
  { id: 'p-res-out', name: 'Tom Fernandes', role: 'Res', caps: [], title: 'Resident · checking out', staffId: 'E1040', sites: [] },
  { id: 'p-res-none', name: 'Farah Siddiqui', role: 'Res', caps: [], title: 'Resident · no request yet', staffId: 'E1080', sites: [] },
  { id: 'p-hk', name: 'Lakshmi Devi', role: 'Res', caps: ['Housekeeping'], title: 'Resident + Housekeeping', staffId: 'E1045', sites: ['PV', 'LV'] },
  { id: 'p-mc', name: 'Meera Pillai', role: 'MC', caps: [], title: 'Maintenance Coordinator', staffId: 'E9006', sites: ['PV', 'MA', 'LV'] },
  { id: 'p-tech', name: 'Arjun Nair', role: 'Tech', caps: [], title: 'Technician', staffId: 'E9007', sites: ['PV', 'MA', 'LV'] },
  { id: 'p-vend', name: 'Imran @ CoolAir Services', role: 'Vend', caps: [], title: 'Contractor · CoolAir Services', sites: ['PV'], vendor: 'CoolAir Services' },
  { id: 'p-vend2', name: 'Dinesh @ BrightSpark Electrical', role: 'Vend', caps: [], title: 'Contractor · BrightSpark Electrical', sites: ['PV'], vendor: 'BrightSpark Electrical' },
  { id: 'p-sec', name: 'Sanjay Kumar', role: 'Sec', caps: ['NightKeys'], title: 'Security', staffId: 'E9008', sites: ['PV', 'MA', 'LV'] },
  { id: 'p-mgr', name: 'Deepa Iyer', role: 'Mgr', caps: [], title: 'Read-only Manager', staffId: 'E9009', sites: 'all' },
  { id: 'p-aud', name: 'Farhan Ali', role: 'Aud', caps: [], title: 'Auditor', staffId: 'E9010', sites: 'all' },
]

export type NavItem = { id: string; label: string; icon: IconName; group: string }
const N = (id: string, label: string, icon: IconName, group: string): NavItem => ({ id, label, icon, group })
const dash = N('dashboard', 'Dashboard', 'dashboard', '')

function navForRole(r: Role, p: Persona): NavItem[] {
  const has = (c: Cap) => p.caps.includes(c)
  const isStaffAdmin = r === 'AA' || r === 'SA'
  const items: NavItem[] = [dash]
  if (r === 'Res') {
    items.push(N('request', 'Request a bed', 'bed', 'My stay'), N('maintenance', 'Maintenance', 'wrench', 'My stay'), N('incidents', 'Incidents & SOS', 'siren', 'My stay'))
    if (has('Housekeeping')) items.push(N('housekeeping', 'My work', 'brush', 'Work'))
    return items
  }
  if (isStaffAdmin || r === 'Rec' || has('StaffMaster')) items.push(N('staff', 'Staff directory', 'users', 'People'))
  if (isStaffAdmin) items.push(N('exits', 'Joiners & exits', 'exit', 'People'))
  if (isStaffAdmin || r === 'Rec' || r === 'MC') items.push(N('clearances', 'Clearances', 'clipboard', 'People'))
  if (isStaffAdmin) items.push(N('users', 'Users & access', 'userCog', 'People'))
  if (['SA', 'AA', 'Rec', 'MC', 'Mgr'].includes(r)) items.push(N('inventory', 'Sites & rooms', 'building', 'Accommodation'))
  if (['SA', 'AA', 'Rec', 'Mgr'].includes(r)) items.push(N('allocations', 'Allocations', 'bed', 'Accommodation'))
  if (['SA', 'AA', 'Rec'].includes(r)) items.push(N('transfers', 'Transfers & swaps', 'swap', 'Accommodation'))
  if (isStaffAdmin || has('PolicyApprover') || has('BackupApprover') || r === 'MC') items.push(N('approvals', 'Approvals', 'checkCircle', 'Requests'))
  if (['AA', 'Rec'].includes(r)) items.push(N('request', 'New request', 'plus', 'Requests'))
  if (['SA', 'AA', 'Rec'].includes(r)) items.push(N('waitlist', 'Waitlist & offers', 'hourglass', 'Requests'))
  if (['AA', 'Rec', 'MC'].includes(r) || has('Housekeeping') || has('FinalInspection')) items.push(N('housekeeping', 'Housekeeping', 'brush', 'Operations'))
  if (['AA', 'Rec', 'SA'].includes(r) || has('EmergencyCheckin')) items.push(N('emergency', 'Emergency check-in', 'siren', 'Operations'))
  if (['AA', 'Rec', 'SA'].includes(r) || has('NightKeys')) items.push(N('keys', 'Keys', 'key', 'Operations'))
  if (['AA', 'Rec', 'Sec', 'SA'].includes(r)) items.push(N('visitors', 'Visitors', 'users', 'Operations'))
  if (['AA', 'MC', 'Sec', 'SA'].includes(r)) items.push(N('contractors', r === 'Sec' ? 'Contractor gate' : 'Contractors', 'truck', 'Operations'))
  if (['AA', 'SA'].includes(r) || has('OutageExport')) items.push(N('outage', 'Outage mode', 'radio', 'Operations'))
  if (['AA', 'Rec', 'MC', 'Tech', 'Vend', 'SA'].includes(r)) items.push(N('maintenance', 'Maintenance', 'wrench', 'Operations'))
  if (['AA', 'Rec', 'Sec', 'SA'].includes(r)) items.push(N('incidents', 'Incidents & SOS', 'shield', 'Operations'))
  if (['SA', 'AA', 'Rec', 'Mgr', 'MC', 'Sec', 'Aud'].includes(r)) items.push(N('reports', 'Reports', 'chart', 'Insight'))
  if (isStaffAdmin) items.push(N('notifications', 'Notification log', 'send', 'Insight'))
  if (['SA', 'Aud'].includes(r) || has('PolicyApprover')) items.push(N('audit', 'Audit log', 'scroll', 'Insight'))
  if (r === 'SA') items.push(N('settings', 'Configuration', 'settings', 'Insight'))
  return items
}
const GROUP_ORDER = ['', 'My stay', 'Work', 'People', 'Accommodation', 'Requests', 'Operations', 'Insight']
export function navFor(p: Persona): NavItem[] {
  const merged = new Map<string, NavItem>()
  for (const r of [p.role, ...(p.extraRoles ?? [])]) for (const n of navForRole(r, p)) if (!merged.has(n.id)) merged.set(n.id, n)
  return [...merged.values()].sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group))
}
