'use client'
/** Browser-side helper for the JSON API. Every answer is either { ok: true, data } or a failure with reason / owner / next. */
export interface ApiOk<T> { ok: true; data: T; message?: string; requestId: string }
export interface ApiFail { ok: false; code: string; reason: string; owner?: string; next?: string; fields?: Record<string, string>; detail?: unknown; requestId: string }
export type ApiResult<T> = ApiOk<T> | ApiFail

export async function api<T = unknown>(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<ApiResult<T>> {
  try {
    const res = await fetch(path, {
      method, credentials: 'same-origin',
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return await res.json() as ApiResult<T>
  } catch {
    return { ok: false, code: 'network', reason: 'Could not reach the server', next: 'Check your connection and try again', requestId: '' }
  }
}
export const post = <T = unknown>(path: string, body?: unknown) => api<T>('POST', path, body ?? {})
