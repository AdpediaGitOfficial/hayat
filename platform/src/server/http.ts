/**
 * The only way to write a JSON route handler. It makes the safe path the short path:
 *  1. same-origin check on state-changing requests (CSRF, with SameSite=Lax cookies),
 *  2. session -> acting identity (expiry, revocation, active mode),
 *  3. the "change your password first" restriction,
 *  4. the policy check for the declared action (deny by default),
 *  5. Zod validation of the JSON body,
 *  6. a Result turned into a status code and a JSON body that always carries reason / owner / next action.
 * Declaring `access` is mandatory, so a route cannot exist without saying who may call it; the permission
 * contract test enumerates registered routes.
 */
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { z, type ZodType } from 'zod'
import { currentUser } from '@/server/auth/current'
import { clearedCookie, COOKIE_NAME, readCookie } from '@/server/auth/session'
import { fail, failure, type Failure, type Result } from '@/server/command/result'
import type { RequestContext } from '@/server/command/context'
import { decide, type Action } from '@/server/policy'
import { getClock } from '@/server/runtime'
import { confirmPasswordRc } from '@/server/auth/reauth'
import { getConfig } from '@/server/config/registry'
import { getDb } from '@/server/db/client'

export type Access =
  | { kind: 'public' }
  /** Machine callers (a scheduler): `Authorization: Bearer $INTERNAL_JOB_TOKEN`. Disabled (404) when the token is not configured. */
  | { kind: 'internal' }
  /** Any signed-in user, no module action (own session, own password). */
  | { kind: 'authenticated'; allowMustChange?: boolean }
  /** A policy action; the command still checks the specific record's scope. */
  | { kind: 'action'; action: Action }

export interface RouteMeta { name: string; method: string; access: Access }
export const REGISTERED_ROUTES: RouteMeta[] = []

export interface Reply { cookies: string[] }

export type ReauthAction = 'emergency.initiate' | 'emergency.decide' | 'access.role_change' | 'access.grant' | 'waitlist.queue_override'
/**
 * D-03 at the API: when the action is in the configured list (`auth.reauth_actions`, P-02 pending sign-off) the request body must carry
 * `confirmPassword`, the actor's own password. `when` limits it to the bodies that really are the high-risk case (for example only a
 * queue override). The field is checked and removed; handlers and body schemas never see it.
 */
export interface ReauthRule { action: ReauthAction; when?: (body: any) => boolean }

export interface RouteDef<S extends ZodType | undefined> {
  /** Stable identifier, e.g. 'auth.login'. Shown in logs and used by the contract test. */
  name: string
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  access: Access
  body?: S
  reauth?: ReauthRule
  handler: (rc: RequestContext, body: S extends ZodType ? z.infer<S> : undefined, req: Request, reply: Reply, ctx: { params: Record<string, string> }) => Promise<Result<unknown>>
}

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS'])

export function clientIp(req: Request): string | undefined {
  // Behind a trusted proxy that overwrites this header (see README). Never trusted for authorization, only logging and rate limiting.
  const fwd = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
  const ip = fwd || req.headers.get('x-real-ip') || undefined
  return ip && /^[0-9a-fA-F:.]{3,45}$/.test(ip) ? ip : undefined
}

export function sameOrigin(req: Request): boolean {
  const site = req.headers.get('sec-fetch-site')
  if (site && site !== 'same-origin' && site !== 'none') return false
  const origin = req.headers.get('origin')
  if (origin && origin !== 'null') {
    const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? new URL(req.url).host
    try { return new URL(origin).host === host } catch { return false }
  }
  return origin !== 'null'
}

/** A handler may return one of these to send raw bytes (an attachment, a CSV) instead of JSON. Always as a download, never inline. */
export class FileResponse {
  constructor(readonly bytes: Buffer | string, readonly filename: string, readonly contentType: string) {}
}

function respond(r: Result<unknown>, requestId: string, cookies: string[]): Response {
  if (r.ok && r.data instanceof FileResponse) {
    const headers = new Headers({
      'content-type': r.data.contentType, 'cache-control': 'private, no-store', 'x-request-id': requestId, 'x-content-type-options': 'nosniff',
      'content-disposition': `attachment; filename="${r.data.filename.replace(/[^\w. ()-]/g, '_')}"`,
    })
    for (const c of cookies) headers.append('set-cookie', c)
    return new Response(typeof r.data.bytes === 'string' ? r.data.bytes : new Uint8Array(r.data.bytes), { status: 200, headers })
  }
  const headers = new Headers({ 'content-type': 'application/json', 'cache-control': 'no-store', 'x-request-id': requestId })
  for (const c of cookies) headers.append('set-cookie', c)
  if (r.ok) return new Response(JSON.stringify({ ok: true, data: r.data ?? null, message: r.message, requestId }), { status: 200, headers })
  const { status, ...rest } = r
  return new Response(JSON.stringify({ ...rest, requestId }), { status, headers })
}

function fieldsFrom(err: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {}
  for (const i of err.issues) out[i.path.join('.') || '_'] ??= i.message
  return out
}

export function route<S extends ZodType | undefined = undefined>(def: RouteDef<S>) {
  const method = def.method ?? (def.body ? 'POST' : 'GET')
  REGISTERED_ROUTES.push({ name: def.name, method, access: def.access })
  const handler = async (req: Request, ctx: { params?: Record<string, string> } = {}): Promise<Response> => {
    const requestId = randomUUID()
    const reply: Reply = { cookies: [] }
    const clock = getClock()
    const ip = clientIp(req)
    try {
      if (!SAFE.has(req.method) && !sameOrigin(req)) {
        return respond(failure('csrf', 'This request did not come from this site', { next: 'Reload the page and try again' }), requestId, [])
      }
      let rc: RequestContext
      if (def.access.kind === 'public') {
        rc = undefined as unknown as RequestContext
      } else if (def.access.kind === 'internal') {
        const expected = process.env.INTERNAL_JOB_TOKEN
        if (!expected) return respond(fail.notFound(), requestId, [])
        const given = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
        const a = createHash('sha256').update(given).digest(), b = createHash('sha256').update(expected).digest()
        if (!timingSafeEqual(a, b)) return respond(fail.unauthenticated(), requestId, [])
        rc = undefined as unknown as RequestContext
      } else {
        const token = readCookie(req.headers.get('cookie'))
        const cur = await currentUser(token, { clock, requestId, ip })
        if ('ok' in cur) return respond(cur as Failure, requestId, token ? [clearedCookie()] : [])
        const allowMust = def.access.kind === 'authenticated' && def.access.allowMustChange
        if (cur.mustChangePassword && !allowMust) return respond(fail.passwordChange(), requestId, [])
        if (def.access.kind === 'action') {
          const d = decide(cur.rc.actor, def.access.action)
          if (!d.allowed) return respond(fail.forbidden(`do this (${def.access.action})`), requestId, [])
        }
        rc = cur.rc
      }
      let body: unknown = undefined
      if (def.body) {
        let raw: unknown
        try { raw = await req.json() } catch { return respond(fail.invalid('The request body must be JSON'), requestId, []) }
        if (def.reauth && raw && typeof raw === 'object' && !Array.isArray(raw)) {
          const { confirmPassword, ...rest } = raw as Record<string, unknown>
          raw = rest
          const listed = (await getConfig(getDb(), 'auth.reauth_actions')).includes(def.reauth.action)
          if (listed && (!def.reauth.when || def.reauth.when(rest))) {
            const denied = await confirmPasswordRc(rc, typeof confirmPassword === 'string' ? confirmPassword : undefined)
            if (denied) return respond(denied, requestId, [])
          }
        }
        const parsed = def.body.safeParse(raw)
        if (!parsed.success) return respond(fail.invalid('Some fields need attention', fieldsFrom(parsed.error)), requestId, [])
        body = parsed.data
      }
      const result = await def.handler(rc, body as never, req, reply, { params: ctx.params ?? {} })
      return respond(result, requestId, reply.cookies)
    } catch (e) {
      console.error(JSON.stringify({ level: 'error', msg: 'route failed', route: def.name, requestId, error: e instanceof Error ? e.message : String(e) }))
      return respond(fail.internal(), requestId, [])
    }
  }
  return Object.assign(handler, { meta: { name: def.name, method, access: def.access } satisfies RouteMeta })
}

export { COOKIE_NAME }
