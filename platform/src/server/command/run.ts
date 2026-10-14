import { getDb } from '@/server/db/client'
import { fail, failure, type Failure, type Result } from './result'
import type { CommandContext, RequestContext } from './context'

class Rollback extends Error {
  constructor(public readonly failure: Failure) { super(failure.reason) }
}

interface PgLikeError { code?: string; constraint?: string; message?: string }
const isPg = (e: unknown): e is PgLikeError => typeof e === 'object' && e !== null && 'code' in e

/** Database errors that mean "the rules said no", not "we broke": turned into results the UI can explain. */
export function mapDbError(e: unknown): Failure | undefined {
  if (!isPg(e)) return undefined
  const cause = (e as { cause?: unknown }).cause
  if (isPg(cause) && cause.code) return mapDbError(cause)
  switch (e.code) {
    case '23P01': return fail.conflict('That bed was just taken for overlapping dates', 'Another admin', 'Pick the next suggested bed')
    case '40P01': case '40001': return fail.conflict('Another change got there first', undefined, 'Try again')
    case '23505': return fail.conflict(`That already exists${e.constraint ? ` (${e.constraint})` : ''}`, undefined, 'Open the existing record instead')
    case 'GH001': return fail.conflict('That state change is not allowed', 'System', 'Follow the normal workflow')
    case '23503': return fail.invalid('A linked record does not exist')
    case '23514': return fail.invalid(`A value is not allowed${e.constraint ? ` (${e.constraint})` : ''}`)
    default: return undefined
  }
}

/**
 * Runs one business action as one transaction. If the function returns a failure, or throws, EVERYTHING it wrote
 * (including its audit row) is rolled back: a refused command leaves no trace except the request log.
 * A lost race (deadlock / serialization failure) is retried once.
 */
export async function runCommand<T>(rc: RequestContext, fn: (c: CommandContext) => Promise<Result<T>>): Promise<Result<T>> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await getDb().transaction(async tx => {
        const r = await fn({ ...rc, tx, now: rc.clock.now() })
        if (!r.ok) throw new Rollback(r)
        return r
      })
    } catch (e) {
      if (e instanceof Rollback) return e.failure
      const mapped = mapDbError(e)
      const retryable = isPg(e) && (e.code === '40P01' || e.code === '40001')
      if (retryable && attempt === 0) continue
      if (mapped) return mapped
      console.error(JSON.stringify({ level: 'error', msg: 'command failed', requestId: rc.requestId, error: e instanceof Error ? e.message : String(e) }))
      return failure('internal', fail.internal().reason, { owner: 'Support', next: `Try again. Quote request ${rc.requestId} if it keeps happening` })
    }
  }
}
