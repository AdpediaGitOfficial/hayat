import { createContext, useContext } from 'react'
import type { Persona, Res, State } from './domain/types'
import { useToast } from './ui'

export type Ctx = {
  persona: Persona
  s: State
  now: number
  page: string
  params: Record<string, string>
  go: (page: string, params?: Record<string, string>) => void
  scope: string
  setScope: (v: string) => void
}
export const AppCtx = createContext<Ctx>(null as unknown as Ctx)
export const useCtx = () => useContext(AppCtx)

/** Wraps a store result: toasts success or the blocked-state triple (reason, owner, next action). */
export function useAct() {
  const toast = useToast()
  return function act<T>(res: Res<T>, onOk?: (r: Extract<Res<T>, { ok: true }>) => void): Res<T> {
    if (res.ok) { if (res.msg) toast(res.msg); onOk?.(res) }
    else toast([res.reason, res.owner && `Owner: ${res.owner}`, res.next && `Next: ${res.next}`].filter(Boolean).join(' · '), true)
    return res
  }
}
