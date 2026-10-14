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
  group: 'auth' | 'calendar' | 'timers' | 'import'
  label: string
  description: string
  schema: ZodType<T>
  default: T
  /** Decision or open-question reference, e.g. 'D-47' or 'GH-14'. */
  ref: string
  status: DecisionStatus
  /** May be overridden per site (otherwise global only). */
  perSite?: boolean
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
  'timers.waitlist_entry_days': def({ group: 'timers', label: 'Waitlist entry lifetime (days)', description: '', schema: int(1, 365), default: 15, ref: 'D-51', status: 'decided' }),
  'timers.offer_hours': def({ group: 'timers', label: 'Bed offer lifetime (hours from confirmed delivery)', description: '', schema: int(1, 720), default: 48, ref: 'D-52', status: 'decided' }),
  'timers.offer_unviewed_hours': def({ group: 'timers', label: 'Offer not viewed: Reception follow-up (hours)', description: '', schema: int(1, 720), default: 24, ref: 'D-52', status: 'decided' }),
  'timers.emergency_deadline_hours': def({ group: 'timers', label: 'Emergency check-in approval deadline (hours)', description: '', schema: int(1, 168), default: 24, ref: 'D-60', status: 'decided' }),
  'timers.emergency_realert_hours': def({ group: 'timers', label: 'Emergency re-alert interval (hours)', description: '', schema: int(1, 168), default: 24, ref: 'D-60', status: 'decided' }),
  'timers.emergency_escalate_after': def({ group: 'timers', label: 'Emergency: escalate after unanswered alerts', description: '', schema: int(1, 10), default: 2, ref: 'D-60', status: 'decided' }),
  'timers.routine_sla_business_days': def({ group: 'timers', label: 'Routine approval SLA (business days)', description: '', schema: int(1, 30), default: 2, ref: 'D-33', status: 'decided' }),
  'timers.no_show_hours': def({ group: 'timers', label: 'No-show after arrival date (hours)', description: '', schema: int(1, 168), default: 24, ref: 'D-54', status: 'decided' }),
  'timers.sos_ack_minutes': def({ group: 'timers', label: 'SOS acknowledgement (minutes)', description: '', schema: int(1, 60), default: 5, ref: 'D-80', status: 'decided' }),

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
