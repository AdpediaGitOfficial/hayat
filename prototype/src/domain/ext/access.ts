/* People and access: permission changes with maker-checker (P-9), account lifecycle, rehire (P-8),
   and the request "changes requested" loop (P-12). */
import type { Cap, Persona, Role } from '../types'
import { fail, fullName, guard, log, notify, ok, reauth, run, uid } from '../core'
import { actingAs, deny, hasRole, selfAction, staffById } from '../rules'
import { nowMs } from '../time'
import { PERSONAS } from '../../roles'

const personaById = (id: string) => PERSONAS.find(p => p.id === id)

export const accessActions = {
  /** Maker step. Role, scope and capability changes never take effect until a different Super Admin approves (D-22, D-27). */
  requestPermissionChange(actor: Persona, f: { kind: 'grant' | 'revoke' | 'role' | 'scope'; targetPersonaId: string; cap?: Cap; role?: Role; sites?: string[] | 'all'; reason: string; expires?: string }) {
    return run<string>(d => {
      const e = guard(deny(actor, 'permission.request', 'request permission changes'))
      if (e) return e
      const target = personaById(f.targetPersonaId)
      if (!target) return fail('Choose a user')
      if (!f.reason.trim()) return fail('A reason is required for every grant or role change', 'You', 'Enter the reason')
      if ((f.kind === 'grant' || f.kind === 'revoke') && !f.cap) return fail('Choose a capability')
      if (f.kind === 'role' && !f.role) return fail('Choose a role')
      if (f.kind === 'scope' && !f.sites) return fail('Choose the sites')
      if (d.changes.some(c => c.status === 'Pending' && c.targetPersonaId === f.targetPersonaId && c.kind === f.kind && c.cap === f.cap)) return fail('The same change is already waiting for approval')
      const id = uid(d, 'PC')
      d.changes.push({ id, kind: f.kind, targetPersonaId: f.targetPersonaId, cap: f.cap, role: f.role, sites: f.sites, reason: f.reason, expires: f.expires || undefined, requestedBy: actor.name, requestedByPersonaId: actor.id, at: nowMs(), status: 'Pending' })
      log(d, actor, 'Permission change requested', `${f.kind} ${f.cap ?? f.role ?? ''} for ${target.name}: ${f.reason}`)
      notify(d, { toRole: 'SA', text: `Permission change for ${target.name} needs a second Super Admin: ${f.kind} ${f.cap ?? f.role ?? 'scope'}.` })
      return ok('Requested. A different Super Admin must approve before it takes effect', id)
    })
  },
  decidePermissionChange(actor: Persona, id: string, approve: boolean, note: string) {
    return run(d => {
      const e = guard(deny(actor, 'permission.decide', 'approve permission changes'))
      if (e) return e
      const c = d.changes.find(x => x.id === id)
      if (!c || c.status !== 'Pending') return fail('Already decided')
      if (c.requestedByPersonaId === actor.id) return fail('You can’t approve a change you requested', 'Separation of duties (D-26)', 'A second Super Admin approves (maker-checker)')
      if (c.targetPersonaId === actor.id) return fail('You can’t approve a change to your own permissions', 'Separation of duties (D-26)', 'A different Super Admin approves')
      if (!approve && !note.trim()) return fail('A reason is required to reject', 'You', 'Enter the reason')
      const target = personaById(c.targetPersonaId)!
      if (approve) {
        const ov = d.overrides[target.id] ?? (d.overrides[target.id] = { addCaps: [], removeCaps: [] })
        if (c.kind === 'grant') { ov.addCaps.push({ cap: c.cap!, expires: c.expires, changeId: c.id }); ov.removeCaps = ov.removeCaps.filter(x => x !== c.cap) }
        else if (c.kind === 'revoke') { ov.addCaps = ov.addCaps.filter(x => x.cap !== c.cap); if (!ov.removeCaps.includes(c.cap!)) ov.removeCaps.push(c.cap!) }
        else if (c.kind === 'role') {
          const demoting = (actingAs(d, target, nowMs()).role === 'SA') && c.role !== 'SA'
          const activeSAs = PERSONAS.filter(p => actingAs(d, p, nowMs()).role === 'SA' && !actingAs(d, p, nowMs()).revoked)
          if (demoting && activeSAs.length <= 1) return fail('The last active Super Admin can’t be removed or downgraded (D-27)', 'System', 'Appoint another Super Admin first')
          ov.role = c.role
        } else ov.sites = c.sites
      }
      c.status = approve ? 'Applied' : 'Rejected'; c.decidedBy = actor.name; c.decidedAt = nowMs(); c.decisionNote = note
      log(d, actor, `Permission change ${approve ? 'applied' : 'rejected'}`, `${c.kind} ${c.cap ?? c.role ?? ''} for ${target.name} (requested by ${c.requestedBy})`)
      return ok(approve ? `Applied. ${target.name}'s access updated` : 'Rejected')
    })
  },
  setAccountActive(actor: Persona, personaId: string, active: boolean, reason: string) {
    return run(d => {
      const target = personaById(personaId)
      if (!target) return fail('Unknown account')
      const adminAccount = target.role !== 'Res'
      const e = guard(deny(actor, adminAccount ? 'account.reset.admin' : 'account.reset.staff', adminAccount ? 'change admin accounts (Super Admin only)' : 'change staff accounts'))
      if (e) return e
      if (!reason.trim()) return fail('A reason is required', 'You', 'Enter the reason')
      if (!active && personaId === actor.id) return fail('You can’t deactivate your own account')
      if (!active && target.role === 'SA') {
        const others = PERSONAS.filter(p => p.id !== personaId && actingAs(d, p, nowMs()).role === 'SA' && !actingAs(d, p, nowMs()).revoked)
        if (others.length === 0) return fail('The last active Super Admin can’t be deactivated (D-27)', 'System', 'Appoint another Super Admin first')
      }
      d.accounts[personaId] = { ...(d.accounts[personaId] ?? {}), active, deactivatedReason: active ? undefined : reason }
      // pending approvals of a deactivated approver must be reassigned before the change is final
      log(d, actor, active ? 'Account reactivated' : 'Account deactivated', `${target.name}: ${reason}`)
      return ok(active ? `${target.name} can sign in again` : `${target.name}'s login is revoked immediately`)
    })
  },
  /** D-07/D-08: admin-assisted. The temporary credential is shown once, to be handed over through the approved offline process. */
  resetPassword(actor: Persona, personaId: string) {
    return run<string>(d => {
      const target = personaById(personaId)
      if (!target) return fail('Unknown account')
      const adminAccount = target.role !== 'Res'
      const e = guard(deny(actor, adminAccount ? 'account.reset.admin' : 'account.reset.staff', adminAccount ? 'reset admin passwords (Super Admin only)' : 'reset staff passwords'))
      if (e) return e
      const cred = Array.from({ length: 10 }, () => 'abcdefghjkmnpqrstuvwxyz23456789'[Math.floor(Math.random() * 31)]).join('')
      d.accounts[personaId] = { ...(d.accounts[personaId] ?? { active: true }), mustChange: true, credentialIssuedAt: nowMs() }
      log(d, actor, 'Password reset (admin-assisted)', `${target.name}: temporary credential issued, must change at first login`)
      return ok(`Temporary credential for ${target.name}: ${cred}. Hand it over through the approved offline process. They must change it at first login`, cred)
    })
  },

  /** AT-032: rehire reuses the existing profile. An old clearance case that is still open blocks it unless the Policy Approver waived it (D-41). */
  rehire(actor: Persona, staffId: string, f: { reason: string; confirm: boolean }) {
    return run(d => {
      const e = guard(deny(actor, 'rehire', 'reactivate former staff'), reauth(f.confirm, 'rehire'))
      if (e) return e
      const s = staffById(d, staffId)
      if (!s) return fail('Staff not found')
      if (s.status !== 'Left') return fail(`${s.name} is not marked as Left`)
      if (!f.reason.trim()) return fail('A reason is required', 'You', 'Enter the reason')
      const open = d.clearances.find(c => c.staffId === staffId && c.status === 'Open')
      if (open && !open.waiver) return fail(`${s.name} has an open clearance case`, 'Policy Approver', 'Complete the clearance, or ask the Policy Approver to waive it')
      s.status = 'Active'; s.loginActive = true; s.rehiredAt = nowMs(); s.leftAt = undefined; s.leftEffective = undefined
      d.accounts[staffId] = { active: true, mustChange: true }
      log(d, actor, 'Rehired', `${s.name} (${s.id}): same profile reused, no duplicate created. ${f.reason}`)
      notify(d, { toRole: 'PA', text: `${s.name} was reactivated (${f.reason}).` })
      return ok(`${s.name} is active again on the same profile. Login restored with a forced password change`)
    })
  },

  /** An approver may send a request back instead of rejecting it (P-12). Nothing is reserved while it is with the requester. */
  requestChanges(actor: Persona, requestId: string, note: string) {
    return run(d => {
      const q = d.requests.find(x => x.id === requestId)
      if (!q || q.status !== 'Submitted') return fail('This request is no longer open')
      const e = guard(deny(actor, 'request.approve', 'ask for changes'), selfAction(actor, q.staffId, 'return'))
      if (e) return e
      if (!note.trim()) return fail('Say what needs to change', 'You', 'Enter the note for the requester')
      q.status = 'ChangesRequested'; q.changeNote = note
      log(d, actor, 'Changes requested', `${fullName(d, q.staffId)}: ${note}`)
      notify(d, { toStaffId: q.staffId, email: true, text: `Your accommodation request needs changes: ${note}` })
      return ok('Returned to the requester')
    })
  },
  resubmitRequest(actor: Persona, requestId: string, f: { arrival: string; end: string; note: string }) {
    return run(d => {
      const q = d.requests.find(x => x.id === requestId)
      if (!q || q.status !== 'ChangesRequested') return fail('Only a request returned for changes can be resubmitted')
      if (actor.staffId !== q.staffId && !hasRole(actor, 'AA') && !hasRole(actor, 'Rec')) return fail('Only the requester can resubmit')
      if (!f.end || f.end < f.arrival) return fail('Check the dates: the end date must be after arrival', 'Requester', 'Fix the dates')
      ;(q.revisions ??= []).push({ at: nowMs(), arrival: q.arrival, end: q.end, note: q.note, by: actor.name })
      q.arrival = f.arrival; q.end = f.end; q.note = f.note; q.status = 'Submitted'; q.changeNote = undefined; q.createdAt = nowMs()
      log(d, actor, 'Request resubmitted', `${fullName(d, q.staffId)} · revision ${q.revisions.length + 1}`)
      notify(d, { toRole: 'AA', text: `${fullName(d, q.staffId)} resubmitted their request with changes.` })
      return ok('Resubmitted for approval')
    })
  },
}
