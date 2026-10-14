import { z } from 'zod'
import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import { configItem, site } from '@/server/db/schema'
import { audit } from '@/server/audit'
import { authorize } from '@/server/command/authorize'
import { runCommand } from '@/server/command/run'
import { fail, ok, type Result } from '@/server/command/result'
import type { RequestContext } from '@/server/command/context'
import { CONFIG, getConfig, isConfigKey, type ConfigDef } from '@/server/config/registry'

export const input = z.object({
  key: z.string().trim().min(1).max(120),
  value: z.unknown(),
  /** Only for settings the registry marks `perSite`. */
  siteId: z.uuid().optional(),
  reason: z.string().trim().min(1, 'Say why').max(500),
})
export type Input = z.infer<typeof input>
export const body = input.omit({ key: true })
export interface Output { key: string; version: number; siteId: string | null; value: unknown }

/**
 * Saves a NEW VERSION of a setting (config_item is append-only for every role, the owner included; the current value
 * is the newest version). The value is checked against the registry's schema; the decision reference and its status
 * (decided / default / open) are copied from the registry so the history shows what a value was based on.
 */
export async function setConfig(rc: RequestContext, raw: Input): Promise<Result<Output>> {
  return runCommand(rc, async c => {
    const denied = authorize(c, 'system_config.manage')
    if (denied) return denied
    if (!isConfigKey(raw.key)) return fail.invalid('There is no such setting', { key: 'Unknown setting' })
    const key = raw.key
    const def = CONFIG[key] as ConfigDef
    if (raw.siteId && !def.perSite) return fail.invalid('This setting applies to every site; it cannot be set for one site', { siteId: 'Leave empty' })
    if (raw.siteId) {
      const [s] = await c.tx.select({ id: site.id }).from(site).where(and(eq(site.id, raw.siteId), isNull(site.archivedAt)))
      if (!s) return fail.invalid('That site does not exist or is archived', { siteId: 'Choose an active site' })
    }
    if (raw.value === undefined) return fail.invalid('Give the new value', { value: 'Required' })
    const parsed = def.schema.safeParse(raw.value)
    if (!parsed.success) {
      const why = parsed.error.issues[0]?.message ?? 'Not a valid value'
      return fail.invalid(`That value is not allowed for "${def.label}": ${why}`, { value: why })
    }

    // Two administrators saving the same setting at once queue up, so versions are consecutive and nobody gets a "duplicate" error.
    await c.tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key + ':' + (raw.siteId ?? '')}, 0))`)
    const scope = raw.siteId ? eq(configItem.scopeSiteId, raw.siteId) : isNull(configItem.scopeSiteId)
    const [latest] = await c.tx.select({ version: configItem.version }).from(configItem).where(and(eq(configItem.key, key), scope)).orderBy(desc(configItem.version)).limit(1)
    const effectiveBefore = await getConfig(c.tx, key, raw.siteId)
    const version = (latest?.version ?? 0) + 1
    await c.tx.insert(configItem).values({
      key, scopeSiteId: raw.siteId ?? null, version, value: parsed.data, decisionRef: def.ref, decisionStatus: def.status,
      reason: raw.reason, effectiveFrom: c.now, createdBy: c.user.id, createdAt: c.now,
    })
    await audit(c, {
      action: 'config.changed', entityType: 'config', siteId: raw.siteId, reason: raw.reason,
      before: { key, value: effectiveBefore, version: latest?.version ?? null, decisionRef: def.ref, decisionStatus: def.status },
      after: { key, value: parsed.data, version, decisionRef: def.ref, decisionStatus: def.status },
    })
    return ok({ key, version, siteId: raw.siteId ?? null, value: parsed.data }, `Saved as version ${version}`)
  })
}
