import { FixedClock } from '@/server/clock'
import type { RequestContext } from '@/server/command/context'
import type { Actor } from '@/server/policy'

/** A RequestContext for calling commands directly in tests (without HTTP). */
export function rcFor(userId: string, actor: Partial<Actor> & Pick<Actor, 'role'>, clock = new FixedClock()): RequestContext {
  return {
    actor: { caps: [], sites: [], ...actor },
    user: { id: userId, username: 'test', staffId: actor.staffId },
    requestId: `test-${Math.random().toString(36).slice(2, 8)}`,
    clock,
  }
}
