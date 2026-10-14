import type { ApprovalSource } from './types'

const SOURCES = new Map<string, ApprovalSource>()
export function registerApprovalSource(s: ApprovalSource): void {
  if (SOURCES.has(s.kind) && SOURCES.get(s.kind) !== s) throw new Error(`approval source ${s.kind} is registered twice`)
  SOURCES.set(s.kind, s)
}
export const approvalSources = (): ApprovalSource[] => [...SOURCES.values()]
