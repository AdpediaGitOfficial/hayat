/* Security and access: visitor register and gate (P-4), contractor accounts, visit windows and gate checks (P-5),
   SOS escalation (P-6). Gate checks re-validate everything at the moment of entry; a failed check denies access and the reason is logged. */
import type { ContractorVisit, Persona, State } from '../types'
import { fail, fullName, guard, log, ok, registerTick, run, uid } from '../core'
import { activeStayOfStaff, bedById, deny, selfAction, staffById } from '../rules'
import { dateStr, fmtDateTime, fmtTime, nowMs } from '../time'

const minutes = (hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m }
const minOfDay = (ms: number) => { const dt = new Date(ms); return dt.getUTCHours() * 60 + dt.getUTCMinutes() }

/* ---------------- contractors ---------------- */
/** Every reason a contractor visit cannot be allowed right now (empty list = access valid). */
export function visitProblems(d: State, v: ContractorVisit, now: number, opts: { ignoreWindow?: boolean } = {}): string[] {
  const out: string[] = []
  const vendor = d.vendors.find(x => x.id === v.vendorId)
  const contract = d.contracts.find(c => c.vendorId === v.vendorId)
  const wo = d.workOrders.find(w => w.id === v.workOrderId)
  const T = dateStr(now)
  if (!vendor) out.push('Unknown vendor')
  if (!contract) out.push('No contract on file')
  else {
    if (contract.status !== 'Active') out.push(`Contract is ${contract.status.toLowerCase()}`)
    if (T < contract.from || T > contract.to) out.push(`Contract is not valid today (${contract.from} to ${contract.to})`)
    if (contract.docsValidUntil < T) out.push(`Worker documents expired on ${contract.docsValidUntil}`)
  }
  if (!wo) out.push('Job not found')
  else {
    if (vendor && wo.assignee !== vendor.name) out.push('Job is not assigned to this vendor')
    if (wo.status === 'Verified') out.push('Job is already closed')
    const bed = bedById(d, wo.bedId)
    if (bed && bed.siteId !== v.siteId) out.push('Job is at a different site')
  }
  if (!opts.ignoreWindow && (now < v.from || now > v.to)) out.push(`Outside the approved visit window (${fmtDateTime(v.from)} to ${fmtTime(v.to)})`)
  return out
}
/** D-76: a contractor's login works only inside contract + documents + job + visit window. Returns the reason it doesn't, or null. */
export function contractorAccess(d: State, vendorName: string, workOrderId: string, now: number): string | null {
  const wo = d.workOrders.find(w => w.id === workOrderId)
  const vendor = d.vendors.find(v => v.name === vendorName)
  if (!wo || !vendor || wo.assignee !== vendorName) return 'This job is not assigned to your company'
  const visits = d.contractorVisits.filter(v => v.workOrderId === workOrderId && v.vendorId === vendor.id && (v.status === 'Checked in' || v.status === 'Gate pass valid'))
  if (visits.length === 0) return 'No active visit: you need a valid gate pass and a visit window for this job'
  const valid = visits.find(v => visitProblems(d, v, now).length === 0)
  if (!valid) return visitProblems(d, visits[0], now)[0]
  return null
}

export const securityActions = {
  /* ---------- visitors ---------- */
  registerVisitor(actor: Persona, f: { name: string; hostStaffId: string; purpose: string; siteId: string; from: number; to: number; walkIn?: boolean }) {
    return run<string>(d => {
      const own = !!actor.staffId && actor.staffId === f.hostStaffId && actor.role === 'Res'
      const e = guard(own ? (d.config.residentVisitorRequests ? null : fail('Residents can’t pre-register visitors yet', 'Accommodation Admin', 'Ask Reception to register your visitor. Resident requests need an explicit grant')) : deny(actor, 'visitor.register', 'register visitors'))
      if (e) return e
      if (!f.name.trim()) return fail('Visitor name is required')
      const host = staffById(d, f.hostStaffId)
      if (!host || host.status !== 'Active') return fail('The host must be an active resident')
      if (!activeStayOfStaff(d, host.id)) return fail(`${host.name} doesn't have a stay, so can't host visitors`, 'Reception', 'Choose a resident host')
      if (f.to <= f.from) return fail('The visit must end after it starts')
      const h = d.config.visitorHours
      const sameDay = dateStr(f.from) === dateStr(f.to)
      if (!f.walkIn && (minOfDay(f.from) < minutes(h.open) || minOfDay(f.to) > minutes(h.close) || (!sameDay && !d.config.visitorOvernight)))
        return fail(`Visits are allowed ${h.open}–${h.close}${d.config.visitorOvernight ? '' : ', same day, no overnight'}`, 'Visitor policy (GH-10, open)', 'Adjust the window, or ask the Accommodation Admin for an exception')
      const id = uid(d, 'VS')
      d.visitors.push({ id, name: f.name, hostStaffId: host.id, purpose: f.purpose, siteId: f.siteId, from: f.from, to: f.to, status: f.walkIn ? 'Walk-in pending' : 'Pre-registered', requiresApproval: true, createdBy: actor.staffId ?? actor.name })
      log(d, actor, f.walkIn ? 'Walk-in visitor logged' : 'Visitor registered', `${f.name} → host ${host.name}`)
      return ok(f.walkIn ? 'Walk-in logged. Confirm with the host before letting them in' : 'Visitor registered. Reception approves before arrival', id)
    })
  },
  approveVisitor(actor: Persona, id: string) {
    return run(d => {
      const v = d.visitors.find(x => x.id === id)
      if (!v || !['Pre-registered', 'Walk-in pending'].includes(v.status)) return fail('Nothing to approve')
      const e = guard(deny(actor, 'visitor.approve', 'approve visitors'), selfAction(actor, v.hostStaffId, 'approve a visitor for'))
      if (e) return e
      v.status = 'Approved'; v.approvedBy = actor.name
      log(d, actor, 'Visitor approved', `${v.name} → host ${fullName(d, v.hostStaffId)}`)
      return ok('Approved. Security can check them in during the window')
    })
  },
  denyVisitor(actor: Persona, id: string, reason: string) {
    return run(d => {
      const v = d.visitors.find(x => x.id === id)
      if (!v || !['Pre-registered', 'Walk-in pending', 'Approved'].includes(v.status)) return fail('Nothing to deny')
      const e = guard(deny(actor, 'visitor.approve', 'deny visitors'))
      if (e) return e
      if (!reason.trim()) return fail('A reason is required', 'You', 'Enter the reason')
      v.status = 'Denied'; v.denyReason = reason
      log(d, actor, 'Visitor denied', `${v.name}: ${reason}`)
      return ok('Denied')
    })
  },
  visitorGateIn(actor: Persona, id: string, f: { idChecked: boolean }) {
    return run(d => {
      const e = guard(deny(actor, 'visitor.gate', 'record gate entry'))
      if (e) return e
      const v = d.visitors.find(x => x.id === id)
      if (!v) return fail('Visitor not found')
      if (v.status !== 'Approved') return fail(v.status === 'Walk-in pending' ? 'Walk-in not confirmed yet' : `Visitor is ${v.status.toLowerCase()}`, 'Reception', 'Reception approves the visitor first')
      if (!f.idChecked) return fail('Check the visitor’s identity first', 'Security', 'Verify ID, then record entry')
      const now = nowMs()
      if (now < v.from - 15 * 60000 || now > v.to) return fail(`Outside the approved window (${fmtTime(v.from)}–${fmtTime(v.to)})`, 'Reception', 'Ask Reception to amend the visit')
      v.status = 'Checked in'; v.checkedInAt = now
      log(d, actor, 'Visitor gate-in', `${v.name} → host ${fullName(d, v.hostStaffId)}`)
      return ok(`${v.name} checked in`)
    })
  },
  visitorGateOut(actor: Persona, id: string) {
    return run(d => {
      const e = guard(deny(actor, 'visitor.gate', 'record gate exit'))
      if (e) return e
      const v = d.visitors.find(x => x.id === id)
      if (!v || v.status !== 'Checked in') return fail('Visitor is not checked in')
      v.status = 'Checked out'; v.checkedOutAt = nowMs()
      log(d, actor, 'Visitor gate-out', v.name)
      return ok(`${v.name} checked out`)
    })
  },

  /* ---------- contractors ---------- */
  scheduleContractorVisit(actor: Persona, f: { vendorId: string; workOrderId: string; from: number; to: number; workers: string[]; escort?: string }) {
    return run<string>(d => {
      const e = guard(deny(actor, 'contractor.manage', 'schedule contractor visits'))
      if (e) return e
      const vendor = d.vendors.find(v => v.id === f.vendorId), wo = d.workOrders.find(w => w.id === f.workOrderId)
      if (!vendor || !wo) return fail('Choose a vendor and a job')
      if (wo.assignee !== vendor.name) return fail(`This job isn't assigned to ${vendor.name}`, 'Maintenance Coordinator', 'Assign the job to the vendor first')
      if (f.to <= f.from) return fail('The visit must end after it starts')
      if (f.workers.length === 0) return fail('List at least one worker')
      const id = uid(d, 'CV')
      d.contractorVisits.push({ id, vendorId: vendor.id, workOrderId: wo.id, siteId: bedById(d, wo.bedId)!.siteId, from: f.from, to: f.to, workers: f.workers, escort: f.escort, status: 'Scheduled' })
      log(d, actor, 'Contractor visit scheduled', `${vendor.name} · ${wo.title}`)
      return ok('Visit scheduled. Issue a gate pass once prerequisites are valid', id)
    })
  },
  issueGatePass(actor: Persona, visitId: string) {
    return run(d => {
      const e = guard(deny(actor, 'contractor.manage', 'issue gate passes'))
      if (e) return e
      const v = d.contractorVisits.find(x => x.id === visitId)
      if (!v || v.status !== 'Scheduled') return fail('Only a scheduled visit gets a gate pass')
      const problems = visitProblems(d, v, nowMs(), { ignoreWindow: true })
      if (problems.length) return fail(`No gate pass: ${problems.join('; ')}`, 'Contractor sponsor (GH-09, open)', 'Fix the prerequisite, then issue the pass')
      v.status = 'Gate pass valid'
      log(d, actor, 'Gate pass issued', `${d.vendors.find(x => x.id === v.vendorId)?.name} · ${fmtDateTime(v.from)}`)
      return ok('Gate pass is valid for the visit window')
    })
  },
  /** AT-023: everything is re-checked at the gate. If anything fails the entry is denied, the reason is recorded, and Security and the coordinator see it. */
  contractorGateIn(actor: Persona, visitId: string) {
    const attempt = run(d => {
      const e = guard(deny(actor, 'contractor.gate', 'record contractor entry'))
      if (e) return e
      const v = d.contractorVisits.find(x => x.id === visitId)
      if (!v) return fail('Visit not found')
      if (v.status === 'Checked in') return fail('Already checked in')
      if (v.status !== 'Gate pass valid') return fail(v.status === 'Scheduled' ? 'No gate pass has been issued for this visit' : `Visit is ${v.status.toLowerCase()}`, 'Maintenance Coordinator', 'Issue a gate pass first')
      const problems = visitProblems(d, v, nowMs())
      if (problems.length) return fail(`Access denied: ${problems.join('; ')}`, 'Maintenance Coordinator', 'Resolve the prerequisite or reschedule')
      v.status = 'Checked in'; v.checkedInAt = nowMs()
      log(d, actor, 'Contractor gate-in', `${d.vendors.find(x => x.id === v.vendorId)?.name} · ${v.workers.join(', ')}`)
      return ok('Checked in. Escort required: ' + (v.escort ?? 'none'))
    })
    if (!attempt.ok && attempt.reason.startsWith('Access denied')) {
      run(d => {
        const v = d.contractorVisits.find(x => x.id === visitId)
        if (v && v.status === 'Gate pass valid') {
          v.status = 'Denied'; v.denyReason = attempt.reason.replace('Access denied: ', '')
          log(d, actor, 'Contractor access denied', `${d.vendors.find(x => x.id === v.vendorId)?.name}: ${v.denyReason}`)
        }
        return ok()
      })
    }
    return attempt
  },
  contractorGateOut(actor: Persona, visitId: string) {
    return run(d => {
      const e = guard(deny(actor, 'contractor.gate', 'record contractor exit'))
      if (e) return e
      const v = d.contractorVisits.find(x => x.id === visitId)
      if (!v || !['Checked in', 'Revoked'].includes(v.status) || !v.checkedInAt) return fail('Not on site')
      v.status = 'Checked out'; v.checkedOutAt = nowMs()
      log(d, actor, 'Contractor gate-out', d.vendors.find(x => x.id === v.vendorId)?.name ?? '')
      return ok('Checked out')
    })
  },
  setContractStatus(actor: Persona, contractId: string, status: 'Active' | 'Suspended' | 'Terminated', reason: string) {
    return run(d => {
      const e = guard(deny(actor, 'contractor.manage', 'change contract status'))
      if (e) return e
      const c = d.contracts.find(x => x.id === contractId)
      if (!c) return fail('Contract not found')
      if (!reason.trim()) return fail('A reason is required', 'You', 'Enter the reason')
      c.status = status
      const vendor = d.vendors.find(v => v.id === c.vendorId)!
      log(d, actor, `Contract ${status.toLowerCase()}`, `${vendor.name}: ${reason}`)
      if (status !== 'Active') {
        // new access is blocked; anyone already on site triggers a human-managed response, never silence
        for (const v of d.contractorVisits.filter(x => x.vendorId === c.vendorId && ['Scheduled', 'Gate pass valid', 'Checked in'].includes(x.status))) {
          if (v.status === 'Checked in') { v.status = 'Revoked'; notifyOnSite(d, vendor.name, v) } else v.status = 'Revoked'
        }
      }
      return ok(`Contract ${status.toLowerCase()}. New access is blocked`)
    })
  },
  revokeContractorVisit(actor: Persona, visitId: string, reason: string) {
    return run(d => {
      const e = guard(deny(actor, 'contractor.manage', 'revoke visits'))
      if (e) return e
      const v = d.contractorVisits.find(x => x.id === visitId)
      if (!v || !['Scheduled', 'Gate pass valid', 'Checked in'].includes(v.status)) return fail('Nothing to revoke')
      if (!reason.trim()) return fail('A reason is required', 'You', 'Enter the reason')
      const wasIn = v.status === 'Checked in'
      v.status = 'Revoked'
      log(d, actor, 'Contractor visit revoked', reason)
      if (wasIn) notifyOnSite(d, d.vendors.find(x => x.id === v.vendorId)!.name, v)
      return ok(wasIn ? 'Revoked. Security is alerted to escort them out' : 'Revoked')
    })
  },

  /* ---------- SOS ---------- */
  closeIncident(actor: Persona, id: string, note: string) {
    return run(d => {
      const e = guard(deny(actor, 'incident.ack', 'close incidents'))
      if (e) return e
      const i = d.incidents.find(x => x.id === id)
      if (!i) return fail('Not found')
      if (!i.ackAt) return fail('Acknowledge before closing', 'Security', 'Acknowledge first')
      if (!note.trim()) return fail('Closing needs the action taken', 'You', 'Enter the closure note')
      i.closed = true; i.closeNote = note
      log(d, actor, 'Incident closed', note)
      return ok('Incident closed')
    })
  },
}

function notifyOnSite(d: State, vendorName: string, v: ContractorVisit) {
  d.notifications.unshift({ id: uid(d, 'N'), at: nowMs(), toRole: 'Sec', email: true, emailStatus: 'queued', attempts: 0, nextAttemptAt: nowMs(), critical: true, dedupeKey: 'rev:' + v.id,
    text: `Access revoked while ${vendorName} (${v.workers.join(', ')}) are on site. Escort them out and confirm.` })
}

/* ---- visitor and contractor overstay, SOS escalation ---- */
registerTick(({ d, now, note, touch }) => {
  for (const v of d.visitors) {
    if (v.status === 'Checked in' && now > v.to && !v.overstayNotified) {
      v.overstayNotified = true; touch()
      note({ toRole: 'Sec', text: `Visitor overstay: ${v.name} (host ${fullName(d, v.hostStaffId)}) was due out at ${fmtTime(v.to)}.`, dedupeKey: 'vover:' + v.id })
      note({ toStaffId: v.hostStaffId, text: `Your visitor ${v.name} is past the approved time. Please see them out.`, dedupeKey: 'vhost:' + v.id })
    }
  }
  for (const v of d.contractorVisits) {
    if (v.status === 'Checked in' && now > v.to && !v.overstayNotified) {
      v.overstayNotified = true; touch()
      note({ toRole: 'Sec', email: true, critical: true, text: `Contractor overstay: ${d.vendors.find(x => x.id === v.vendorId)?.name} was due out at ${fmtTime(v.to)}.`, dedupeKey: 'cover:' + v.id })
    }
  }
  // SOS: unacknowledged past the threshold escalates to the Security Supervisor, then the designated accommodation authority. It stays open until a human resolves it.
  for (const i of d.incidents) {
    if (i.kind !== 'SOS' || i.ackAt || i.closed) continue
    const lvl = i.escalation ?? 0
    const t1 = i.at + d.config.sosAckMinutes * 60_000, t2 = t1 + d.config.sosEscalationMinutes * 60_000
    if (lvl < 1 && now >= t1) {
      i.escalation = 1; touch()
      note({ toRole: 'Sec', email: true, critical: true, text: `SOS NOT ACKNOWLEDGED in ${d.config.sosAckMinutes} min: “${i.text}”. Escalated to the Security Supervisor.`, dedupeKey: 'sos1:' + i.id })
      log(d, 'System', 'SOS escalated', `Level 1: ${i.text}`)
    }
    if ((i.escalation ?? 0) < 2 && now >= t2) {
      i.escalation = 2; touch()
      note({ toRole: 'AA', email: true, critical: true, text: `SOS STILL UNACKNOWLEDGED after ${d.config.sosAckMinutes + d.config.sosEscalationMinutes} min: “${i.text}”. Escalated to the accommodation authority.`, dedupeKey: 'sos2a:' + i.id })
      note({ toRole: 'PA', email: true, critical: true, text: `SOS STILL UNACKNOWLEDGED: “${i.text}”.`, dedupeKey: 'sos2p:' + i.id })
      log(d, 'System', 'SOS escalated', `Level 2: ${i.text}`)
    }
  }
})
