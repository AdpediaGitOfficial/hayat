import type { Actor } from '@/server/policy'
import type { Db } from '@/server/db/client'
import type { Clock } from '@/server/clock'

/** A drizzle transaction handle: same query API as Db. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

export interface UserInfo {
  id: string
  username: string
  staffId?: string
}

/** Who is acting and how, without a transaction yet. Built once per request. */
export interface RequestContext {
  actor: Actor
  user: UserInfo
  sessionId?: string
  requestId: string
  ip?: string
  clock: Clock
}

/** What a command receives: the request context plus its transaction. Everything a command writes goes through `tx`. */
export interface CommandContext extends RequestContext {
  tx: Tx
  now: Date
}
