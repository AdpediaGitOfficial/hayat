/**
 * Sweeps: the scheduled work behind every timer (waitlist expiry, offer expiry, reminders, escalation, no-show...).
 *
 * Rules every sweep follows (docs/STAGE-2.md section 2):
 *  - it NEVER approves, rejects, moves or checks anyone out; it may remind, escalate, and release a hold or close an
 *    entry that the rules say lapses,
 *  - it is idempotent: running it twice, or two instances at once, does the thing once (state checks under row locks,
 *    notification dedupe keys),
 *  - it reads time from the injected clock only.
 * runSweep() additionally takes an advisory lock per sweep, so a second runner skips rather than doubles up.
 */
import { eq } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { getDb, getPool, type Db } from '@/server/db/client'
import { auditEvent } from '@/server/db/schema'
import { sweepRun } from '@/server/db/schema.alloc'
import type { Clock } from '@/server/clock'
import type { Tx } from '@/server/command/context'

export type SweepSummary = Record<string, number>
export interface SweepContext { clock: Clock; now: Date; db: Db; requestId: string }
export interface Sweep { name: string; description: string; run(ctx: SweepContext): Promise<SweepSummary> }

const REGISTRY = new Map<string, Sweep>()
export function registerSweep(s: Sweep): void {
  if (REGISTRY.has(s.name) && REGISTRY.get(s.name) !== s) throw new Error(`sweep ${s.name} is registered twice`)
  REGISTRY.set(s.name, s)
}
export const listSweeps = (): Sweep[] => [...REGISTRY.values()].sort((a, b) => a.name.localeCompare(b.name))

export interface SweepOutcome { name: string; ok: boolean; skipped?: boolean; summary?: SweepSummary; error?: string }

export async function runSweep(name: string, clock: Clock): Promise<SweepOutcome> {
  const sweep = REGISTRY.get(name)
  if (!sweep) return { name, ok: false, error: 'unknown sweep' }
  // One runner per sweep at a time, across processes. Session-level lock on a dedicated connection.
  const lockClient = await getPool().connect()
  try {
    const got = (await lockClient.query<{ ok: boolean }>(`SELECT pg_try_advisory_lock(hashtext($1)) AS ok`, [`sweep:${name}`])).rows[0].ok
    if (!got) return { name, ok: true, skipped: true }
    const db = getDb()
    const [run] = await db.insert(sweepRun).values({ name, startedAt: clock.now() }).returning({ id: sweepRun.id })
    const requestId = `sweep-${name}-${randomUUID().slice(0, 8)}`
    try {
      const summary = await sweep.run({ clock, now: clock.now(), db, requestId })
      await db.update(sweepRun).set({ finishedAt: new Date(), ok: true, summary }).where(eq(sweepRun.id, run.id))
      return { name, ok: true, summary }
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      console.error(JSON.stringify({ level: 'error', msg: 'sweep failed', sweep: name, requestId, error }))
      await db.update(sweepRun).set({ finishedAt: new Date(), ok: false, error }).where(eq(sweepRun.id, run.id))
      return { name, ok: false, error }
    }
  } finally {
    await lockClient.query(`SELECT pg_advisory_unlock(hashtext($1))`, [`sweep:${name}`]).catch(() => undefined)
    lockClient.release()
  }
}

/** Runs every registered sweep in name order. One sweep failing never stops the others. */
export async function runSweeps(clock: Clock, only?: string[]): Promise<SweepOutcome[]> {
  const out: SweepOutcome[] = []
  for (const s of listSweeps()) if (!only || only.includes(s.name)) out.push(await runSweep(s.name, clock))
  return out
}

/**
 * A system transaction for sweeps: audit rows carry no user and the role 'system'. Throwing rolls everything back.
 * Use one transaction per item, not one for the whole sweep, so one bad row never blocks the rest.
 */
export async function systemTx<T>(ctx: SweepContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return ctx.db.transaction(fn)
}

export async function auditSystem(tx: Tx, ctx: Pick<SweepContext, 'requestId'>, e: { action: string; entityType?: string; entityId?: string; siteId?: string; reason?: string; before?: unknown; after?: unknown }) {
  await tx.insert(auditEvent).values({
    actorUserId: null, actorRole: 'system', action: e.action, entityType: e.entityType ?? null, entityId: e.entityId ?? null,
    siteId: e.siteId ?? null, reason: e.reason ?? null, before: e.before ?? null, after: e.after ?? null, requestId: ctx.requestId,
  })
}

