import { and, inArray, isNull } from 'drizzle-orm'
import { notification } from '@/server/db/schema.alloc'
import { runCommand } from '@/server/command/run'
import { ok, type Result } from '@/server/command/result'
import type { RequestContext } from '@/server/command/context'
import { visibleTo } from './index'

export async function markRead(rc: RequestContext, ids?: string[]): Promise<Result<{ marked: number }>> {
  return runCommand(rc, async c => {
    const rows = await c.tx.update(notification).set({ readAt: c.now })
      .where(and(visibleTo(c.actor), isNull(notification.readAt), ids?.length ? inArray(notification.id, ids) : undefined))
      .returning({ id: notification.id })
    return ok({ marked: rows.length })
  })
}
