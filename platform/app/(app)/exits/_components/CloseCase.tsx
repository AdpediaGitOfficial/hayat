'use client'
/** Closing the case: the button, or the blocked state with every reason, owner and next action. */
import { Alert, Blocked, Button } from '@/ui'
import type { Blocker } from '@/server/commands/exit/rules'
import { Problem, useCall } from './common'

export function CloseCase({ caseId, blockers, canClose, why, owner, next, staysClosed }: {
  caseId: string; blockers: Blocker[]; canClose: boolean; why?: string; owner?: string; next?: string; staysClosed?: boolean
}) {
  const { run, busy, err } = useCall()
  return (
    <div className="stack" style={{ gap: 10 }}>
      {err && <Problem f={err} />}
      {blockers.length > 0 && (
        <div className="stack" style={{ gap: 8 }} data-testid="close-blockers">
          <Alert tone="warning" title={`${blockers.length} mandatory item${blockers.length === 1 ? '' : 's'} must be done or waived first`} />
          {blockers.map(b => <Blocked key={b.itemId} why={`${b.label}: ${b.status === 'outstanding' ? 'Outstanding' : 'Open'}`} owner={b.owner} next={b.next} />)}
        </div>
      )}
      {blockers.length === 0 && !canClose && why && <Blocked why={why} owner={owner} next={next} />}
      {blockers.length === 0 && canClose && <Alert tone="success" title="Every mandatory item is done or waived" detail={staysClosed ? undefined : 'Closing clears the case. It does not check anyone out and does not make a bed ready.'} />}
      <div><Button variant="primary" disabled={busy || !canClose || blockers.length > 0} onClick={() => void run(`/api/v1/exit/${caseId}/close`, {})}>Close the clearance case</Button></div>
    </div>
  )
}
