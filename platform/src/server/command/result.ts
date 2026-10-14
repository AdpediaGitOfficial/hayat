/**
 * Every command and API route answers with a Result. A refusal always says WHY, WHO owns the next step and
 * WHAT to do next (D-93), so the UI can show "reason + owner + next action" without guessing.
 */
export type ErrorCode =
  | 'unauthenticated' | 'password_change_required' | 'forbidden' | 'not_found' | 'invalid' | 'conflict'
  | 'separation_of_duties' | 'rate_limited' | 'csrf' | 'internal'

const STATUS: Record<ErrorCode, number> = {
  unauthenticated: 401, password_change_required: 403, forbidden: 403, not_found: 404, invalid: 422, conflict: 409,
  separation_of_duties: 403, rate_limited: 429, csrf: 403, internal: 500,
}

export interface Success<T> { ok: true; data: T; message?: string }
export interface Failure {
  ok: false
  code: ErrorCode
  status: number
  reason: string
  owner?: string
  next?: string
  /** Field-level problems for forms: field name -> what to fix. */
  fields?: Record<string, string>
  /** Machine-readable detail, never secrets (for example the blocking dependencies of an archive). */
  detail?: unknown
}
export type Result<T = void> = Success<T> | Failure

export const ok = <T>(data: T, message?: string): Success<T> => ({ ok: true, data, message })
export const done = (message?: string): Success<void> => ({ ok: true, data: undefined, message })

export function failure(code: ErrorCode, reason: string, extra: Partial<Pick<Failure, 'owner' | 'next' | 'fields' | 'detail'>> = {}): Failure {
  return { ok: false, code, status: STATUS[code], reason, ...extra }
}
export const fail = {
  unauthenticated: () => failure('unauthenticated', 'Sign in to continue', { next: 'Sign in' }),
  passwordChange: () => failure('password_change_required', 'You must choose a new password before doing anything else', { next: 'Change your password' }),
  /** The actor lacks the action entirely. */
  forbidden: (what: string, owner = 'Your administrator') => failure('forbidden', `Your role can't ${what}`, { owner, next: 'Ask an administrator, or switch to a role that can' }),
  /** Out-of-scope reads and writes look exactly like a record that doesn't exist (AT-001, AT-002). */
  notFound: () => failure('not_found', 'Not found', { next: 'Check the identifier, or ask an administrator' }),
  invalid: (reason: string, fields?: Record<string, string>) => failure('invalid', reason, { fields, next: 'Fix the highlighted fields' }),
  conflict: (reason: string, owner?: string, next?: string, detail?: unknown) => failure('conflict', reason, { owner, next, detail }),
  sod: (reason: string, next = 'An independent approver must do this (D-26)') => failure('separation_of_duties', reason, { owner: 'Separation of duties (D-26)', next }),
  rateLimited: (minutes: number) => failure('rate_limited', `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}`, { next: 'Wait, then try again' }),
  internal: () => failure('internal', 'Something went wrong on our side', { owner: 'Support', next: 'Try again. If it keeps happening, quote the request id' }),
}
