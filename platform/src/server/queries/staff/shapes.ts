/**
 * The four shapes of a staff record. Each is a closed set of keys: tests assert the exact key set per role, so adding a
 * field here is a deliberate decision about who may see it. Rows are projected to a shape in SQL (see list.ts); these
 * helpers exist for the write side, which returns the full shape to the admins who hold `view`.
 */
import type { StaffShape } from './access'

export interface StaffFull {
  id: string
  employeeId: string
  fullName: string
  gender: 'male' | 'female' | null
  department: string | null
  grade: number | null
  phone: string | null
  email: string | null
  emergencyContact: string | null
  employmentStatus: 'active' | 'left'
  joiningDate: string | null
  leftEffective: string | null
  source: 'manual' | 'csv' | 'migration' | 'seed'
  archivedAt: Date | null
  createdAt: Date
  updatedAt: Date
}
/** A person looking at their own record: everything about themselves, none of the bookkeeping. */
export type StaffOwn = Pick<StaffFull, 'id' | 'employeeId' | 'fullName' | 'gender' | 'department' | 'grade' | 'phone' | 'email' | 'emergencyContact' | 'employmentStatus' | 'joiningDate'>
/** Reception lookup. */
export type StaffMinimum = Pick<StaffFull, 'id' | 'employeeId' | 'fullName' | 'department' | 'employmentStatus'>
/** Security identity check. */
export type StaffIdentity = Pick<StaffFull, 'id' | 'employeeId' | 'fullName' | 'employmentStatus'>

export type StaffByShape = { full: StaffFull; own: StaffOwn; minimum: StaffMinimum; identity: StaffIdentity }
export type StaffRecord = StaffByShape[StaffShape]

export const SHAPE_KEYS: { [S in StaffShape]: readonly (keyof StaffByShape[S])[] } = {
  full: ['id', 'employeeId', 'fullName', 'gender', 'department', 'grade', 'phone', 'email', 'emergencyContact', 'employmentStatus', 'joiningDate', 'leftEffective', 'source', 'archivedAt', 'createdAt', 'updatedAt'],
  own: ['id', 'employeeId', 'fullName', 'gender', 'department', 'grade', 'phone', 'email', 'emergencyContact', 'employmentStatus', 'joiningDate'],
  minimum: ['id', 'employeeId', 'fullName', 'department', 'employmentStatus'],
  identity: ['id', 'employeeId', 'fullName', 'employmentStatus'],
}
