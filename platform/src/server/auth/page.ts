import { cookies, headers } from 'next/headers'
import { notFound, redirect } from 'next/navigation'
import { randomUUID } from 'node:crypto'
import { getClock } from '@/server/runtime'
import { decide, type Action } from '@/server/policy'
import { currentUser, type CurrentUser } from './current'
import { COOKIE_NAME } from './session'

/**
 * For server-rendered pages: who is looking, or a redirect to sign in (or to change the password first).
 * Passing `action` also requires the policy to grant it; otherwise the page is "not found", exactly like an
 * out-of-scope record, so a guessed URL tells a person nothing. The page must still apply scopeFilter() to its queries.
 */
export async function requirePage(action?: Action, opts: { allowMustChange?: boolean } = {}): Promise<CurrentUser> {
  const token = cookies().get(COOKIE_NAME)?.value
  const ip = headers().get('x-forwarded-for')?.split(',')[0]?.trim() || undefined
  const cur = await currentUser(token, { clock: getClock(), requestId: randomUUID(), ip })
  if ('ok' in cur) redirect('/login')
  if (cur.mustChangePassword && !opts.allowMustChange) redirect('/change-password')
  if (action && !decide(cur.rc.actor, action).allowed) notFound()
  return cur
}

/** Signed in already? Used by the sign-in page to skip itself. */
export async function maybeUser(): Promise<CurrentUser | undefined> {
  const token = cookies().get(COOKIE_NAME)?.value
  if (!token) return undefined
  const cur = await currentUser(token, { clock: getClock(), requestId: randomUUID() })
  return 'ok' in cur ? undefined : cur
}
