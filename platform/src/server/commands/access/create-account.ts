import { z } from 'zod'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { roleAssignment, site, staffProfile, userAccount } from '@/server/db/schema'
import { accountSite } from '@/server/db/schema.access'
import { audit } from '@/server/audit'
import { authorize } from '@/server/command/authorize'
import { runCommand } from '@/server/command/run'
import { fail, failure, ok, type Result } from '@/server/command/result'
import type { RequestContext } from '@/server/command/context'
import { ROLES, SCOPE_KINDS } from '@/domain/enums'
import { isFullSuperAdmin, loadTarget, newTemporaryCredential } from './guards'
import { fileRoleChange } from './role-change-core'

export const input = z.object({
  /** The staff profile, by its id or by its business key (the employee ID, D-05). Exactly one. */
  staffId: z.uuid().optional(),
  employeeId: z.string().trim().min(1).max(80).optional(),
  /** Defaults to the employee ID (D-06). */
  username: z.string().trim().min(1).max(80).regex(/^\S+$/, 'No spaces').optional(),
  /** The site this person lives or works in. Required for an Accommodation Admin (it decides who may manage the account). */
  siteId: z.uuid().optional(),
  reason: z.string().trim().max(500).optional(),
  /** Super Admin only: also file the request for a first role beyond the base Resident role (a second Super Admin must approve it). */
  initialRole: z.object({
    role: z.enum(ROLES), scopeKind: z.enum(SCOPE_KINDS), siteId: z.uuid().optional(), buildingId: z.uuid().optional(),
  }).optional(),
}).refine(v => !!v.staffId !== !!v.employeeId, { message: 'Give either the staff id or the employee ID', path: ['employeeId'] })
export type Input = z.infer<typeof input>

export interface Output {
  userId: string
  username: string
  fullName: string
  /** Shown ONCE. Only its Argon2id hash is stored; it is in no log and no audit row. */
  temporaryPassword: string
  roleChangeRequestId?: string
  warnings: string[]
}

/**
 * Admin-assisted activation (D-07, D-08). The account starts `invited` with a temporary password that must be changed
 * at first sign-in, and with the base Resident role (own record only, D-21). Any other role, and any site scope,
 * is a role change: it needs a second Super Admin (D-27).
 */
export async function createAccount(rc: RequestContext, raw: Input): Promise<Result<Output>> {
  return runCommand(rc, async c => {
    const denied = authorize(c, 'users_roles.manage_staff_accounts')
    if (denied) return denied
    const fullSa = isFullSuperAdmin(c.actor)

    if (!raw.siteId && !fullSa) {
      return fail.invalid('Choose the site this person lives or works in', { siteId: 'Required: it decides who can manage this account' })
    }
    if (raw.siteId) {
      const scoped = authorize(c, 'users_roles.manage_staff_accounts', { siteId: raw.siteId })
      if (scoped) return scoped
      const [s] = await c.tx.select({ id: site.id }).from(site).where(and(eq(site.id, raw.siteId), isNull(site.archivedAt)))
      if (!s) return fail.notFound()
    }
    if (raw.initialRole) {
      if (authorize(c, 'users_roles.manage_roles_and_scope')) {
        return failure('forbidden', 'Only a Super Admin can give an account a role other than Resident', {
          owner: 'Super Admin', next: 'Create the account without a role, then ask a Super Admin to request the role',
        })
      }
      if (!raw.reason) return fail.invalid('Say why this role is needed', { reason: 'Required when a role is requested' })
    }

    // The staff record: locked, so two admins creating an account for the same person queue up and the second sees the first.
    const [staff] = await c.tx.select().from(staffProfile)
      .where(raw.staffId ? eq(staffProfile.id, raw.staffId) : sql`lower(btrim(${staffProfile.employeeId})) = lower(btrim(${raw.employeeId!}))`)
      .limit(1).for('update')
    if (!staff) return fail.invalid('No staff record has that employee ID', { employeeId: 'Not found' })
    if (staff.archivedAt) return failure('conflict', 'This staff record is archived', { owner: 'Accommodation Admin', next: 'Restore or re-create the staff record first' })
    if (staff.employmentStatus === 'left') {
      return failure('conflict', `${staff.fullName} is marked as Left, so no account can be created`, { owner: 'Accommodation Admin', next: 'Follow the re-hire process if they are returning' })
    }
    const [existing] = await c.tx.select({ id: userAccount.id }).from(userAccount).where(eq(userAccount.staffId, staff.id)).limit(1)
    if (existing) return failure('conflict', `${staff.fullName} already has an account`, { owner: 'Accommodation Admin', next: 'Reset the password or reactivate the existing account instead' })

    const username = (raw.username ?? staff.employeeId).trim()
    if (!/^\S{1,80}$/.test(username)) return fail.invalid('The employee ID cannot be used as a username as it is', { username: 'Enter a username without spaces' })
    const [taken] = await c.tx.select({ id: userAccount.id }).from(userAccount).where(sql`lower(btrim(${userAccount.username})) = lower(${username})`).limit(1)
    if (taken) return failure('conflict', 'That username is already in use', { owner: 'Accommodation Admin', next: 'Choose a different username' })

    const cred = await newTemporaryCredential()
    const [user] = await c.tx.insert(userAccount).values({
      staffId: staff.id, username, passwordHash: cred.hash, mustChangePassword: true, status: 'invited', createdAt: c.now, updatedAt: c.now,
    }).returning({ id: userAccount.id })
    const [base] = await c.tx.insert(roleAssignment).values({
      userId: user.id, role: 'Res', scopeKind: 'own', grantedBy: c.user.id, createdAt: c.now,
    }).returning({ id: roleAssignment.id })
    if (raw.siteId) await c.tx.insert(accountSite).values({ userId: user.id, siteId: raw.siteId, createdBy: c.user.id, createdAt: c.now })

    let roleChangeRequestId: string | undefined
    let warnings: string[] = []
    if (raw.initialRole) {
      const target = await loadTarget(c.tx, user.id)
      const filed = await fileRoleChange(c, target!, { kind: 'add', spec: raw.initialRole, reason: raw.reason! })
      if ('ok' in filed) return filed
      roleChangeRequestId = filed.id
      warnings = filed.warnings
    }

    await audit(c, {
      action: 'access.account.created', entityType: 'user_account', entityId: user.id, siteId: raw.siteId, reason: raw.reason,
      // Never the password, never the hash.
      after: { username, staffId: staff.id, employeeId: staff.employeeId, status: 'invited', mustChangePassword: true, baseRoleAssignmentId: base.id, roleChangeRequestId: roleChangeRequestId ?? null },
    })
    return ok({ userId: user.id, username, fullName: staff.fullName, temporaryPassword: cred.plain, roleChangeRequestId, warnings },
      'Account created. Hand the temporary password over now: it cannot be shown again')
  })
}
