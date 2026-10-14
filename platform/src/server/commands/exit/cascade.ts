/**
 * Extra steps of the Mark as Left cascade that belong to later stages.
 *
 * D-36 also cancels visitor passes and contractor passes. Those exist in Stage 4. When they do, their package registers a step
 * here with registerExitCascadeStep() and Mark as Left runs it inside the SAME transaction, after the Stage 3 steps and after
 * the clearance case exists. A step that throws or returns a failure rolls the whole Mark as Left back.
 */
import type { CommandContext } from '@/server/command/context'
import type { Failure } from '@/server/command/result'

export interface ExitCascadeContext { staffId: string; caseId: string; siteId?: string; reason: string }
export interface ExitCascadeResult { label: string; count: number }
export type ExitCascadeStep = (c: CommandContext, x: ExitCascadeContext) => Promise<ExitCascadeResult | Failure>

const STEPS: { id: string; run: ExitCascadeStep }[] = []

export function registerExitCascadeStep(id: string, run: ExitCascadeStep): void {
  if (!STEPS.some(s => s.id === id)) STEPS.push({ id, run })
}
export const exitCascadeSteps = (): readonly { id: string; run: ExitCascadeStep }[] => STEPS

// >>> Stage 4 extension point: visitor passes and contractor access passes (D-36).
// Stage 4 adds, in its own package: registerExitCascadeStep('visitor_passes', async (c, x) => { ...cancel future passes of x.staffId...; return { label: 'visitor passes cancelled', count } })
// <<< Stage 4 extension point
