/**
 * Configuration screens (WP-C): every registry key with its current value, default, decision reference and status,
 * and the version history of one key. Reading a value for the application is getConfig() (newest version wins; a stored
 * value that no longer fits the registry schema is ignored and the default applies). Super Admin only.
 */
import { and, desc, eq, isNull } from 'drizzle-orm'
import { getDb } from '@/server/db/client'
import { configItem, site, userAccount } from '@/server/db/schema'
import { decide, type Actor } from '@/server/policy'
import { CONFIG, getConfig, isConfigKey, type ConfigDef, type ConfigKey, type DecisionStatus } from '@/server/config/registry'

export interface ConfigOverride { siteId: string; siteCode: string; siteName: string; value: unknown; version: number; changedAt: string; changedBy: string | null; reason: string | null; valid: boolean }
export interface ConfigRow {
  key: string
  group: string
  label: string
  description: string
  default: unknown
  /** What the application uses now (global). */
  value: unknown
  /** 'default': nothing saved (or the saved value is no longer valid); 'saved': the newest version applies. */
  source: 'default' | 'saved'
  /** A saved version exists but fails the registry schema, so the default is used until someone saves a valid one. */
  storedInvalid: boolean
  version: number | null
  ref: string
  status: DecisionStatus
  /** P-number when this is a proposed policy pending client sign-off. */
  proposed: string | null
  perSite: boolean
  /** The allowed values of a setting that is a choice from a fixed list. */
  options?: string[]
  changedAt: string | null
  changedBy: string | null
  reason: string | null
  overrides: ConfigOverride[]
}
export interface ConfigVersion {
  version: number; value: unknown; valid: boolean; siteId: string | null; siteCode: string | null; decisionRef: string | null; decisionStatus: DecisionStatus | null
  reason: string | null; changedBy: string | null; changedAt: string
}

const optionsOf = (def: ConfigDef): string[] | undefined => {
  const o = (def.schema as unknown as { options?: unknown }).options
  return Array.isArray(o) && o.every(x => typeof x === 'string') ? (o as string[]) : undefined
}

export async function listConfig(actor: Actor): Promise<ConfigRow[]> {
  if (!decide(actor, 'system_config.view').allowed) return []
  const db = getDb()
  const latest = await db.selectDistinctOn([configItem.key, configItem.scopeSiteId], {
    key: configItem.key, scopeSiteId: configItem.scopeSiteId, version: configItem.version, value: configItem.value, reason: configItem.reason,
    createdAt: configItem.createdAt, by: userAccount.username, siteCode: site.code, siteName: site.name,
  }).from(configItem).leftJoin(userAccount, eq(userAccount.id, configItem.createdBy)).leftJoin(site, eq(site.id, configItem.scopeSiteId))
    .orderBy(configItem.key, configItem.scopeSiteId, desc(configItem.version))
  const rows: ConfigRow[] = []
  for (const key of Object.keys(CONFIG) as ConfigKey[]) {
    const def = CONFIG[key] as ConfigDef
    const mine = latest.filter(l => l.key === key)
    const global = mine.find(l => l.scopeSiteId === null)
    const storedValid = global ? def.schema.safeParse(global.value).success : false
    rows.push({
      key, group: def.group, label: def.label, description: def.description, default: def.default,
      value: await getConfig(db, key), source: global && storedValid ? 'saved' : 'default', storedInvalid: !!global && !storedValid,
      version: global?.version ?? null, ref: def.ref, status: def.status, proposed: def.proposed ?? null, perSite: !!def.perSite, options: optionsOf(def),
      changedAt: global?.createdAt.toISOString() ?? null, changedBy: global?.by ?? null, reason: global?.reason ?? null,
      overrides: mine.filter(l => l.scopeSiteId !== null).map(l => ({
        siteId: l.scopeSiteId!, siteCode: l.siteCode ?? '?', siteName: l.siteName ?? '', value: l.value, version: l.version,
        changedAt: l.createdAt.toISOString(), changedBy: l.by, reason: l.reason, valid: def.schema.safeParse(l.value).success,
      })),
    })
  }
  return rows
}

export async function getConfigHistory(actor: Actor, key: string, siteId?: string): Promise<{ row: Pick<ConfigRow, 'key' | 'label' | 'description' | 'ref' | 'status' | 'proposed' | 'perSite' | 'default'>; versions: ConfigVersion[] } | undefined> {
  if (!decide(actor, 'system_config.view').allowed || !isConfigKey(key)) return undefined
  const def = CONFIG[key] as ConfigDef
  const db = getDb()
  const rows = await db.select({
    version: configItem.version, value: configItem.value, scopeSiteId: configItem.scopeSiteId, decisionRef: configItem.decisionRef, decisionStatus: configItem.decisionStatus,
    reason: configItem.reason, createdAt: configItem.createdAt, by: userAccount.username, siteCode: site.code,
  }).from(configItem).leftJoin(userAccount, eq(userAccount.id, configItem.createdBy)).leftJoin(site, eq(site.id, configItem.scopeSiteId))
    .where(and(eq(configItem.key, key), siteId ? eq(configItem.scopeSiteId, siteId) : isNull(configItem.scopeSiteId)))
    .orderBy(desc(configItem.version))
  return {
    row: { key, label: def.label, description: def.description, ref: def.ref, status: def.status, proposed: def.proposed ?? null, perSite: !!def.perSite, default: def.default },
    versions: rows.map(r => ({
      version: r.version, value: r.value, valid: def.schema.safeParse(r.value).success, siteId: r.scopeSiteId, siteCode: r.siteCode,
      decisionRef: r.decisionRef, decisionStatus: r.decisionStatus, reason: r.reason, changedBy: r.by, changedAt: r.createdAt.toISOString(),
    })),
  }
}
