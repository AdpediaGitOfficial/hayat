/**
 * Configuration registry: every tunable value, its type, its default and the decision it comes from.
 * Nothing OPEN is hard-coded elsewhere (CLAUDE.md): code reads values through getConfig(), the default here
 * applies until an administrator saves a version in config_item (append-only, versioned).
 */
import { z, type ZodType } from 'zod'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { configItem } from '@/server/db/schema'
import type { Db } from '@/server/db/client'

export type DecisionStatus = 'decided' | 'default' | 'open'

export interface ConfigDef<T = unknown> {
  group: 'auth' | 'calendar' | 'timers' | 'import' | 'eligibility' | 'stays' | 'exit' | 'keys' | 'readiness' | 'attachments' | 'approvals' | 'transfers' | 'proposals'
  label: string
  description: string
  schema: ZodType<T>
  default: T
  /** Decision or open-question reference, e.g. 'D-47' or 'GH-14'. */
  ref: string
  status: DecisionStatus
  /** May be overridden per site (otherwise global only). */
  perSite?: boolean
  /** A newly PROPOSED policy (docs/DECISIONS.md section "Proposed policies"): pending client sign-off, shown as such. Not an approved decision. */
  proposed?: string
}

const def = <T>(d: ConfigDef<T>): ConfigDef<T> => d
const int = (min: number, max: number) => z.number().int().min(min).max(max)

export const CONFIG = {
  /* ---- sign-in and sessions: GH-14 / G-11 are OPEN, so these are placeholders an administrator can change ---- */
  'auth.password_min_length': def({ group: 'auth', label: 'Minimum password length', description: 'Characters.', schema: int(8, 128), default: 10, ref: 'GH-14', status: 'open' }),
  'auth.lockout_attempts': def({ group: 'auth', label: 'Failed sign-ins before lockout', description: 'Counted inside the lockout window.', schema: int(3, 20), default: 5, ref: 'GH-14', status: 'open' }),
  'auth.lockout_minutes': def({ group: 'auth', label: 'Lockout window (minutes)', description: 'Also the length of the lockout.', schema: int(1, 1440), default: 15, ref: 'GH-14', status: 'open' }),
  'auth.admin_idle_minutes': def({ group: 'auth', label: 'Idle timeout, staff roles (minutes)', description: 'SA, AA, Reception, Maintenance Coordinator, Security, Manager, Auditor.', schema: int(5, 1440), default: 30, ref: 'G-11', status: 'open' }),
  'auth.admin_absolute_hours': def({ group: 'auth', label: 'Maximum session length, staff roles (hours)', description: 'A session never lasts longer, however active.', schema: int(1, 168), default: 12, ref: 'G-11', status: 'open' }),
  'auth.resident_idle_minutes': def({ group: 'auth', label: 'Idle timeout, residents and contractors (minutes)', description: 'Phone-first roles stay signed in longer.', schema: int(5, 10080), default: 720, ref: 'G-11', status: 'open' }),
  'auth.resident_absolute_days': def({ group: 'auth', label: 'Maximum session length, residents and contractors (days)', description: '', schema: int(1, 90), default: 7, ref: 'G-11', status: 'open' }),

  /* ---- calendar: G-01 is OPEN ---- */
  'calendar.weekend_days': def({ group: 'calendar', label: 'Weekend days', description: '0 = Sunday … 6 = Saturday. Used for business-day SLAs.', schema: z.array(int(0, 6)).max(6), default: [0, 6], ref: 'G-01', status: 'open', perSite: true }),
  'calendar.holidays': def({ group: 'calendar', label: 'Holidays (YYYY-MM-DD)', description: 'Not counted as business days.', schema: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).max(400), default: [], ref: 'G-01', status: 'open', perSite: true }),

  /* ---- timers (CLAUDE.md "Key numbers") ---- */
  'timers.waitlist_entry_days': def({ group: 'timers', label: 'Waitlist entry lifetime (days)', description: '', schema: int(1, 365), default: 15, ref: 'D-47', status: 'decided' }),
  'timers.offer_hours': def({ group: 'timers', label: 'Bed offer lifetime (hours from confirmed delivery)', description: '', schema: int(1, 720), default: 48, ref: 'D-49', status: 'decided' }),
  'timers.offer_unviewed_hours': def({ group: 'timers', label: 'Offer not viewed: Reception follow-up (hours)', description: '', schema: int(1, 720), default: 24, ref: 'D-52', status: 'decided' }),
  'timers.emergency_deadline_hours': def({ group: 'timers', label: 'Emergency check-in approval deadline (hours)', description: '', schema: int(1, 168), default: 24, ref: 'D-67', status: 'decided' }),
  'timers.emergency_realert_hours': def({ group: 'timers', label: 'Emergency re-alert interval (hours)', description: '', schema: int(1, 168), default: 24, ref: 'D-67', status: 'decided' }),
  'timers.emergency_escalate_after': def({ group: 'timers', label: 'Emergency: escalate after unanswered alerts', description: '', schema: int(1, 10), default: 2, ref: 'D-67', status: 'decided' }),
  'timers.routine_sla_business_days': def({ group: 'timers', label: 'Routine approval SLA (business days)', description: '', schema: int(1, 30), default: 2, ref: 'D-46', status: 'default' }),
  'timers.no_show_hours': def({ group: 'timers', label: 'No-show after arrival date (hours)', description: '', schema: int(1, 168), default: 24, ref: 'D-58', status: 'default' }),
  'timers.sos_ack_minutes': def({ group: 'timers', label: 'SOS acknowledgement (minutes)', description: '', schema: int(1, 60), default: 5, ref: 'D-77', status: 'default' }),

  /* ---- Stage 2: eligibility (GH-03 OPEN: placeholders, cannot go live until Grand Hyatt supplies the matrix) ---- */
  'eligibility.gender_strict': def({ group: 'eligibility', label: 'Enforce room gender policy', description: 'A male-only or female-only room refuses other staff unless a Policy Approver exception exists.', schema: z.boolean(), default: true, ref: 'GH-03', status: 'open' }),
  'eligibility.min_grade': def({ group: 'eligibility', label: 'Minimum grade for a site', description: '0 = no grade rule. Placeholder until the entitlement matrix is supplied.', schema: int(0, 99), default: 0, ref: 'GH-03', status: 'open', perSite: true }),
  'eligibility.priority_categories': def({ group: 'eligibility', label: 'Waitlist priority categories', description: 'Approved categories that sort ahead of the oldest waiting entry. Empty until defined.', schema: z.array(z.string().trim().min(1).max(60)).max(20), default: [], ref: 'GH-04', status: 'open' }),

  /* ---- Stage 2: waitlist, stays, emergency ---- */
  'timers.waitlist_reminder_days': def({ group: 'timers', label: 'Waitlist expiry reminders (days before expiry)', description: '', schema: z.array(int(1, 30)).max(5), default: [3, 1], ref: 'D-47', status: 'default' }),
  'timers.max_declines_before_requeue': def({ group: 'timers', label: 'Declines before the entry goes to the back of the queue', description: 'The first decline keeps the position.', schema: int(1, 5), default: 2, ref: 'D-50', status: 'decided' }),
  'timers.end_reminder_days': def({ group: 'stays', label: 'End-of-stay reminders (days before the end date)', description: '', schema: z.array(int(1, 60)).max(5), default: [14, 7, 1], ref: 'D-55', status: 'default' }),
  'timers.overdue_grace_days': def({ group: 'stays', label: 'Overdue stay: days before escalation to the Policy Approver', description: 'Flagged on day 1; escalated after this grace. Never an automatic checkout.', schema: int(0, 30), default: 3, ref: 'D-56', status: 'default' }),
  'stays.extension_policy_days': def({ group: 'stays', label: 'Extension within policy (days beyond the current end)', description: 'Longer extensions go to the Policy Approver.', schema: int(1, 3650), default: 90, ref: 'D-57', status: 'default' }),
  'stays.open_ended_review_months': def({ group: 'stays', label: 'Review interval for open-ended stays (months)', description: '', schema: int(1, 60), default: 6, ref: 'D-54', status: 'default' }),
  'timers.emergency_relocation_hours': def({ group: 'timers', label: 'Emergency rejection: relocation task deadline (hours)', description: 'GH-07 owns the real figure.', schema: int(1, 720), default: 48, ref: 'GH-07', status: 'open' }),
  'timers.no_show_extensions': def({ group: 'timers', label: 'No-show extensions allowed per reservation', description: 'AA may extend once, with a reason.', schema: int(0, 5), default: 1, ref: 'D-58', status: 'default' }),

  /* ---- Stage 3: exit, clearance, keys, readiness, attachments ---- */
  'exit.login_revocation': def({ group: 'exit', label: 'When login is revoked after Mark as Left', description: 'Only "immediate" is built (D-35). D-37 (a notice period that keeps login until the effective date) is open.', schema: z.enum(['immediate']), default: 'immediate', ref: 'D-37', status: 'open' }),
  'clearance.checklist': def({
    group: 'exit', label: 'Clearance checklist', description: 'Items added to every clearance case. One more item is added for every key or asset the person still holds.',
    schema: z.array(z.object({ id: z.string().regex(/^[a-z0-9_]{1,40}$/), label: z.string().trim().min(1).max(120), mandatory: z.boolean(), owner: z.enum(['Reception', 'Maintenance', 'AA']) })).max(30),
    default: [
      { id: 'belongings', label: 'Belongings removed from the room', mandatory: true, owner: 'Reception' as const },
      { id: 'inspection', label: 'Room inspection and damage or loss record', mandatory: true, owner: 'Maintenance' as const },
      { id: 'loss_record', label: 'Incident and loss record reviewed', mandatory: false, owner: 'AA' as const },
    ], ref: 'SRS 5.6', status: 'default',
  }),
  'clearance.due_business_days': def({ group: 'exit', label: 'Clearance due (business days after Mark as Left)', description: 'Overdue cases are flagged to the Accommodation Admin and escalated to the Policy Approver. Never closed automatically.', schema: int(1, 60), default: 5, ref: 'GH-18', status: 'open' }),
  'clearance.escalate_after_business_days': def({ group: 'exit', label: 'Clearance overdue: escalate after (business days)', description: '', schema: int(0, 30), default: 2, ref: 'GH-18', status: 'open' }),
  'keys.item_types': def({
    group: 'keys', label: 'Key and asset types', description: 'D-72 (key model for shared rooms) is open: a room key and a bed locker key are both supported as items linked to a room or a bed.',
    schema: z.array(z.object({ id: z.string().regex(/^[a-z0-9_]{1,40}$/), label: z.string().trim().min(1).max(80), category: z.enum(['key', 'asset']) })).min(1).max(30),
    default: [
      { id: 'room_key', label: 'Room key', category: 'key' as const },
      { id: 'locker_key', label: 'Bed locker key', category: 'key' as const },
      { id: 'access_card', label: 'Access card', category: 'asset' as const },
    ], ref: 'D-72', status: 'open',
  }),
  'keys.overdue_grace_days': def({ group: 'keys', label: 'Keys held after departure: days before they count as overdue', description: 'Overdue is computed, never forgotten.', schema: int(0, 30), default: 1, ref: 'D-73', status: 'default' }),
  'readiness.cleaning_checklist': def({
    group: 'readiness', label: 'Cleaning checklist', description: 'Each line is answered by the housekeeper; required lines must be ticked.',
    schema: z.array(z.object({ id: z.string().regex(/^[a-z0-9_]{1,40}$/), label: z.string().trim().min(1).max(120), required: z.boolean() })).min(1).max(30),
    default: [
      { id: 'linen', label: 'Bed linen changed', required: true },
      { id: 'surfaces', label: 'Floor and surfaces cleaned', required: true },
      { id: 'bathroom', label: 'Bathroom cleaned', required: true },
      { id: 'bins', label: 'Bins emptied', required: true },
      { id: 'damage', label: 'Damage or missing items noticed and noted', required: false },
    ], ref: 'D-23', status: 'default',
  }),
  'readiness.cleaning_sla_hours': def({ group: 'readiness', label: 'Cleaning not assigned or not done: remind Reception after (hours)', description: '', schema: int(1, 240), default: 24, ref: 'GH-18', status: 'open' }),
  'attachments.max_mb': def({ group: 'attachments', label: 'Largest attachment (MB)', description: 'PNG, JPEG and PDF only.', schema: int(1, 20), default: 5, ref: 'GH-11', status: 'default' }),

  /* ---- Proposed policies, PENDING CLIENT SIGN-OFF (docs/DECISIONS.md "Proposed policies", docs/SPEC-AMENDMENTS.md).
        Rule for the defaults: a proposal ships ON only where it makes the code match a rule that is already written down
        (APPROVALS.md, D-03, AT-021); a proposal that gives anyone new authority, new restrictions or shows new data ships OFF
        (the previous behaviour) with the machinery built and tested both ways. Changing any of these is a versioned, audited change. ---- */
  'approvals.escalation_backup': def({ group: 'approvals', label: 'Backup approval at the escalation level', description: 'PROPOSED, pending client sign-off (P-01, S-14). A Policy Approver or Backup Approver may decide a standard request, transfer or extension once it has reached the backup level of the approval clock (APPROVALS.md). Before that level, only the Accommodation Admin decides. Off = Accommodation Admin and Super Admin only.', schema: z.boolean(), default: true, ref: 'P-01', status: 'open', proposed: 'P-01' }),
  'auth.reauth_actions': def({
    group: 'approvals', label: 'Actions that re-ask for the password', description: 'PROPOSED, pending client sign-off (P-02, S-18). D-03 names Mark as Left, clearance waiver, emergency check-in, overrides and role changes; Mark as Left, bulk exit, waiver and rehire are always enforced in the command. These are enforced at the API for the actions listed here. Defaults: the D-03 ones. Extra proposals (emergency decisions, capability grants) are off.',
    schema: z.array(z.enum(['emergency.initiate', 'emergency.decide', 'access.role_change', 'access.grant', 'waitlist.queue_override'])).max(10),
    default: ['emergency.initiate', 'access.role_change', 'waitlist.queue_override'] as ('emergency.initiate' | 'emergency.decide' | 'access.role_change' | 'access.grant' | 'waitlist.queue_override')[],
    ref: 'P-02', status: 'open', proposed: 'P-02',
  }),
  'keys.office_hours': def({ group: 'keys', label: 'Key desk office hours (local time)', description: 'PROPOSED, pending client sign-off (P-03, S-19). Used only when "Enforce office hours" is on. Out-of-hours issues and returns are always flagged in the history.', schema: z.object({ from: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), to: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/) }), default: { from: '08:00', to: '20:00' }, ref: 'P-03', status: 'open', proposed: 'P-03', perSite: true }),
  'keys.enforce_office_hours': def({ group: 'keys', label: 'Enforce key desk office hours', description: 'PROPOSED, pending client sign-off (P-03, S-19). On: outside office hours only Night Keys holders (and admins) issue or return keys; Reception is refused with the reason and the owner. Off: no restriction, out-of-hours movements are only flagged.', schema: z.boolean(), default: false, ref: 'P-03', status: 'open', proposed: 'P-03' }),
  'keys.damage_evidence_required': def({ group: 'keys', label: 'Evidence required to mark a key damaged', description: 'PROPOSED, pending client sign-off (P-04, S-19). On: at least one photo or file is required.', schema: z.boolean(), default: false, ref: 'P-04', status: 'open', proposed: 'P-04' }),
  'keys.resident_may_report_lost': def({ group: 'keys', label: 'Residents may report their own key lost', description: 'PROPOSED, pending client sign-off (P-05, S-19). On: a resident can report a key they hold as lost; Reception and the Accommodation Admin are told. They can never mark it returned or found.', schema: z.boolean(), default: false, ref: 'P-05', status: 'open', proposed: 'P-05' }),
  'clearance.waiver_writes_off_key': def({ group: 'exit', label: 'A waiver of a lost key writes it off', description: 'PROPOSED, pending client sign-off (P-06, S-20). On: the key is retired (history kept) so the stay can close. Off: the key stays Lost and keeps the stay open until Keys & assets resolves it.', schema: z.boolean(), default: true, ref: 'P-06', status: 'open', proposed: 'P-06' }),
  'clearance.strict_item_owners': def({ group: 'exit', label: 'Clearance items only by their owner', description: 'PROPOSED, pending client sign-off (P-07, S-20). On: Reception completes Reception items, an Accommodation Admin or Super Admin completes Accommodation Admin items, the Maintenance Coordinator completes Maintenance items. Off: Reception may also complete Accommodation Admin items.', schema: z.boolean(), default: false, ref: 'P-07', status: 'open', proposed: 'P-07' }),
  'exit.sited_only': def({ group: 'exit', label: 'Mark as Left for a person with no accommodation site', description: 'PROPOSED, pending client sign-off (P-08, S-20, S-8). On: only a Super Admin may mark Left a person who has never had a stay, reservation or request at any site. Off: any holder of the action.', schema: z.boolean(), default: false, ref: 'P-08', status: 'open', proposed: 'P-08' }),
  'transfers.reception_may_raise': def({ group: 'transfers', label: 'Reception may raise transfers and swaps', description: 'PROPOSED, pending client sign-off (P-09, S-21). On: Reception raises a transfer or swap on behalf of a resident at their site. They still never approve. PERMISSIONS.md gives Reception execute only.', schema: z.boolean(), default: false, ref: 'P-09', status: 'open', proposed: 'P-09' }),
  'transfers.exception_path': def({ group: 'transfers', label: 'Policy Approver exception for a transfer destination', description: 'PROPOSED, pending client sign-off (P-10, S-21). On: when a transfer destination fails the gender or grade rule, a Policy Approver (never the person or the requester) may grant a recorded exception for that transfer, as for a request (D-25).', schema: z.boolean(), default: true, ref: 'P-10', status: 'open', proposed: 'P-10' }),
  'transfers.swap_partner_lookup': def({ group: 'transfers', label: 'Find a swap partner at another site by employee ID', description: 'PROPOSED, pending client sign-off (P-11, S-21). On: an admin can name the other resident by employee ID for a cross-site swap; only the name and the site are shown, and only for an active stay. Off: the other stay id must come from that site.', schema: z.boolean(), default: false, ref: 'P-11', status: 'open', proposed: 'P-11' }),
  'transfers.future_bookings': def({ group: 'transfers', label: 'Future bookings after a cross-site move', description: 'PROPOSED, pending client sign-off (P-12, S-21). cancel: stray future reservations are cancelled. review: they are left and the Accommodation Admin is asked to review them.', schema: z.enum(['cancel', 'review']), default: 'cancel', ref: 'P-12', status: 'open', proposed: 'P-12' }),
  'readiness.offer_lead_days': def({ group: 'readiness', label: 'Offers on beds that are not ready: lead time (days)', description: 'PROPOSED, pending client sign-off (P-13, S-22). A bed that still needs cleaning or inspection cannot be offered for a start date earlier than today plus this many days (AT-021: a bed that is not ready cannot be allocated). 0 = no restriction (previous behaviour).', schema: int(0, 30), default: 1, ref: 'P-13', status: 'open', proposed: 'P-13' }),

  /* ---- staff import ---- */
  'import.partial_policy': def({ group: 'import', label: 'CSV import with some invalid rows', description: 'save_valid: confirm saves the valid rows and offers the rejected ones as a file. all_or_nothing: any invalid row blocks the import.', schema: z.enum(['save_valid', 'all_or_nothing']), default: 'save_valid', ref: 'AT-005', status: 'default' }),
} as const satisfies Record<string, ConfigDef<never> | ConfigDef<any>>

export type ConfigKey = keyof typeof CONFIG
export type ConfigValue<K extends ConfigKey> = (typeof CONFIG)[K]['default']

type Reader = Pick<Db, 'select'>

/**
 * Current value: the newest version for the site if the key allows per-site values and one exists,
 * else the newest global version, else the registry default. A stored value that no longer matches the
 * registry schema is ignored (default wins) rather than breaking sign-in.
 */
export async function getConfig<K extends ConfigKey>(q: Reader, key: K, siteId?: string): Promise<ConfigValue<K>> {
  const d = CONFIG[key] as ConfigDef
  const scopes: (string | null)[] = d.perSite && siteId ? [siteId, null] : [null]
  for (const scope of scopes) {
    const rows = await q.select({ value: configItem.value }).from(configItem)
      .where(and(eq(configItem.key, key), scope ? eq(configItem.scopeSiteId, scope) : isNull(configItem.scopeSiteId)))
      .orderBy(desc(configItem.version)).limit(1)
    if (rows.length) {
      const parsed = d.schema.safeParse(rows[0].value)
      if (parsed.success) return parsed.data as ConfigValue<K>
    }
  }
  return d.default as ConfigValue<K>
}

export const isConfigKey = (k: string): k is ConfigKey => Object.hasOwn(CONFIG, k)
