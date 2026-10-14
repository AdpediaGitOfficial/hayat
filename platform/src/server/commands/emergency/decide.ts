import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { stay } from '@/server/db/schema'
import { emergencyCheckin, task, type EmergencyVia } from '@/server/db/schema.emergency'
import { audit } from '@/server/audit'
import { runCommand } from '@/server/command/run'
import type { CommandContext, RequestContext } from '@/server/command/context'
import { fail, failure, ok, type Result } from '@/server/command/result'
import { checkEligibility } from '@/server/eligibility'
import { getConfig } from '@/server/config/registry'
import { notify } from '@/server/notify'
import { decide as policyDecide } from '@/server/policy'
import { HOUR, standing } from './rules'
import { auditRefusal, flagsOf, idSchema, loadCase, parseInput, snapCase, textSchema, type LoadedCase, type Refusal } from './shared'

export const approveInput = z.object({
  caseId: idSchema,
  /** Optional, but required when eligibility rules would have failed: the approver says why they accept it (D-66). */
  note: z.string().trim().max(600, 'At most 600 characters').nullish().transform(v => v || null),
})
export const rejectInput = z.object({
  caseId: idSchema,
  /** AT-018: mandatory. It is what the Accommodation Admin and the resident's relocation follow-up rest on. */
  reason: textSchema('Give the reason for rejecting'),
})
export type ApproveInput = z.input<typeof approveInput>
export type RejectInput = z.input<typeof rejectInput>

export interface DecideOut {
  caseId: string
  status: 'approved' | 'rejected'
  stayId: string
  stayStatus: 'active' | 'resolution_pending'
  decidedVia: EmergencyVia
  /** Rejection only: the relocation or checkout task owned by the Accommodation Admin. The resident has NOT been moved. */
  task?: { id: string; ownerRole: 'AA'; dueAt: string }
}

type Kind = 'approve' | 'reject'

/** Approve a provisional stay: Provisional becomes Active. Never the initiator (AT-017), never the person it is about. */
export async function approveEmergency(rc: RequestContext, raw: ApproveInput): Promise<Result<DecideOut>> {
  const p = parseInput(approveInput, raw)
  if (!p.ok) return p
  return run(rc, 'approve', p.data.caseId, { note: p.data.note, reason: null })
}

/** Reject with a reason (AT-018): Provisional becomes Resolution pending, a relocation task for the AA is created, nobody is moved. */
export async function rejectEmergency(rc: RequestContext, raw: RejectInput): Promise<Result<DecideOut>> {
  const p = parseInput(rejectInput, raw)
  if (!p.ok) return p
  return run(rc, 'reject', p.data.caseId, { note: null, reason: p.data.reason })
}

async function run(rc: RequestContext, kind: Kind, caseId: string, o: { note: string | null; reason: string | null }): Promise<Result<DecideOut>> {
  let refusal: Refusal | undefined
  const r = await runCommand(rc, c => decideCase(c, kind, caseId, o, x => { refusal = x }))
  // The command rolled back, so its own audit rows are gone. The refusal is evidence and is written outside the transaction.
  if (refusal) await auditRefusal(rc, refusal)
  return r
}

async function decideCase(c: CommandContext, kind: Kind, caseId: string, o: { note: string | null; reason: string | null }, refused: (r: Refusal) => void): Promise<Result<DecideOut>> {
  const loaded: LoadedCase | undefined = await loadCase(c.tx, caseId, true)
  if (!loaded) return fail.notFound()
  const k = loaded.c
  // A case is visible to the people who may see, approve or start emergency check-ins at its site, and to its initiator.
  const res = { siteId: k.siteId }
  const sees = k.initiatedBy === c.user.id
    || (['emergency_checkin.view', 'emergency_checkin.approve', 'emergency_checkin.initiate'] as const).some(a => policyDecide(c.actor, a, res).allowed)
  if (!sees) return fail.notFound()

  const s = standing({ actor: c.actor, userId: c.user.id }, {
    route: k.approverRoute, escalation: k.escalation, siteId: k.siteId, initiatedBy: k.initiatedBy, initiatedByStaffId: k.initiatedByStaffId, subjectStaffId: k.staffId,
  })
  if (!s.ok && (s.kind === 'initiator' || s.kind === 'subject')) {
    refused({ caseId: k.id, siteId: k.siteId, attempted: kind, who: s.kind, status: k.status })
    return fail.sod(s.why, s.next)
  }
  if (k.status !== 'pending') {
    return failure('conflict', `This emergency check-in was already ${k.status === 'converted' ? 'closed by Mark as Left' : k.status}`, {
      owner: 'Accommodation Admin', next: 'Open the stay to see where it stands', detail: { reason: 'already_decided', status: k.status },
    })
  }
  if (!s.ok) return failure('forbidden', s.why, { owner: s.owner, next: s.next })
  if (loaded.stayStatus !== 'provisional') {
    return failure('conflict', `The stay is no longer provisional (it is ${loaded.stayStatus.replace(/_/g, ' ')})`, {
      owner: 'Accommodation Admin', next: 'Open the stay. A provisional stay that was checked out needs no decision', detail: { reason: 'stay_changed', stayStatus: loaded.stayStatus },
    })
  }

  // Revalidate what the approver is accepting (SRS section 8): eligibility now, for this person in this bed.
  const e = await checkEligibility(c.tx, k.staffId, k.bedId, c.now)
  const flags = e ? flagsOf(e) : { ok: true, reasons: [], failed: [], exceptionable: false }
  if (kind === 'approve' && !flags.ok && !o.note) {
    return fail.invalid('Some rules would have failed for this person in this bed', { note: `Say why you accept this: ${flags.reasons.join('; ')}` })
  }

  const reasonText = kind === 'reject' ? o.reason! : o.note
  const toStatus = kind === 'approve' ? 'approved' : 'rejected'
  const toStay = kind === 'approve' ? 'active' : 'resolution_pending'
  const upd = await c.tx.update(stay).set({ status: toStay }).where(and(eq(stay.id, k.stayId), eq(stay.status, 'provisional'))).returning({ id: stay.id })
  if (upd.length === 0) return failure('conflict', 'The stay changed while you were deciding', { owner: 'Accommodation Admin', next: 'Reload and look at the stay' })
  await c.tx.update(emergencyCheckin).set({
    status: toStatus, decidedBy: c.user.id, decidedByRole: c.actor.role, decidedVia: s.via, decidedAt: c.now, decisionNote: reasonText, decisionFlags: flags,
  }).where(eq(emergencyCheckin.id, k.id))

  let out: DecideOut['task']
  if (kind === 'reject') {
    // D-69: a person (the AA) relocates or checks the resident out. The deadline reminds and escalates; it never moves anyone.
    const hours = await getConfig(c.tx, 'timers.emergency_relocation_hours') // OPEN GH-07: configurable placeholder
    const due = new Date(c.now.getTime() + hours * HOUR)
    const [t] = await c.tx.insert(task).values({
      ownerRole: 'AA', siteId: k.siteId, createdAt: c.now, dueAt: due, refType: 'emergency_checkin', refId: k.id,
      title: `Relocate or check out ${loaded.staffName} (${loaded.employeeId}) from ${loaded.bedCode}`,
      detail: `Emergency check-in rejected: ${reasonText}. The resident is still in the bed. Use a transfer or a checkout on the stay; nothing happens automatically.`,
    }).returning({ id: task.id })
    out = { id: t.id, ownerRole: 'AA', dueAt: due.toISOString() }
    await notify(c.tx, {
      dedupeKey: `emergency:${k.id}:relocation_task`, kind: 'emergency.relocation_task', to: { role: 'AA', siteId: k.siteId }, critical: true,
      text: `Emergency check-in rejected: ${loaded.staffName} (${loaded.employeeId}) is still in ${loaded.bedCode}. Relocate or check them out by ${due.toISOString().slice(0, 16).replace('T', ' ')} UTC. Reason: ${reasonText}`,
      ref: { type: 'task', id: t.id },
    })
  }

  await audit(c, {
    action: kind === 'approve' ? 'emergency.approved' : 'emergency.rejected', entityType: 'emergency_checkin', entityId: k.id, siteId: k.siteId, reason: reasonText ?? undefined,
    before: snapCase(k, loaded.stayStatus),
    after: {
      ...snapCase({ ...k, status: toStatus }, toStay), decidedVia: s.via, decidedByRole: c.actor.role, decidedAt: c.now.toISOString(), eligibilityAtDecision: flags, taskId: out?.id,
      residentMoved: false,
    },
  })
  if (k.initiatedByStaffId) {
    await notify(c.tx, {
      dedupeKey: `emergency:${k.id}:decided`, kind: `emergency.${toStatus}`, to: { staffId: k.initiatedByStaffId },
      text: kind === 'approve'
        ? `The emergency check-in of ${loaded.staffName} in ${loaded.bedCode} was approved. The stay is now active.`
        : `The emergency check-in of ${loaded.staffName} in ${loaded.bedCode} was rejected: ${reasonText}. The resident has not been moved; an Accommodation Admin owns the relocation.`,
      ref: { type: 'emergency_checkin', id: k.id },
    })
  }

  return ok<DecideOut>({ caseId: k.id, status: toStatus, stayId: k.stayId, stayStatus: toStay, decidedVia: s.via, task: out },
    kind === 'approve'
      ? `Approved. ${loaded.staffName} now has an active stay in ${loaded.bedCode}.`
      : `Rejected. ${loaded.staffName} has NOT been moved and is still in ${loaded.bedCode}. A relocation task is open for the Accommodation Admin (due ${out!.dueAt.slice(0, 16).replace('T', ' ')} UTC).`)
}
