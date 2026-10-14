/** What a bed that is not ready says about itself: a label, who owns the next step and what it is (D-93). Plain module: server and client safe. */
export type ReadinessState = 'needs_cleaning' | 'inspection_required' | 'blocked' | 'under_maintenance'
export const READINESS_STATES: readonly ReadinessState[] = ['needs_cleaning', 'inspection_required', 'blocked', 'under_maintenance']

export interface TaskBrief { status: 'open' | 'cleaned'; assigneeName: string | null }
export interface Explained { label: string; owner: string; next: string }

export function explainBed(state: ReadinessState, task: TaskBrief | null, stateReason?: string | null): Explained {
  switch (state) {
    case 'needs_cleaning':
      if (!task) return { label: 'Vacant, no cleaning task', owner: 'Reception', next: 'No cleaning task is open for this bed (migrated or seeded data, or a task was cancelled). Open one by hand with a reason, then assign a housekeeper' }
      if (task.status === 'cleaned') return { label: 'Vacant, task out of step', owner: 'Reception', next: 'Cancel the stale task; a fresh cleaning task opens for the bed' }
      if (!task.assigneeName) return { label: 'Vacant, awaiting cleaning assignment', owner: 'Reception', next: 'Assign a housekeeper' }
      return { label: 'Vacant, being cleaned', owner: task.assigneeName, next: 'Clean the room and tick the checklist' }
    case 'inspection_required':
      if (task?.status === 'cleaned') return { label: 'Vacant, awaiting final inspection', owner: 'Final Inspection holder', next: 'Inspect the room, then pass or fail it' }
      return { label: 'Vacant, awaiting final inspection', owner: 'Reception', next: 'No cleaned task is on record for this bed (migrated or seeded data). Open a task by hand with a reason so the final inspection can proceed' }
    case 'blocked':
      return { label: `Blocked${stateReason ? `: ${stateReason}` : ''}`, owner: 'Maintenance Coordinator', next: `Unblock the bed when the cause is fixed; it then needs cleaning and a final inspection${task ? '. Reception can cancel its open cleaning task meanwhile' : ''}` }
    case 'under_maintenance':
      return { label: 'Under maintenance', owner: 'Maintenance Coordinator', next: 'Finish the work; the bed then returns to cleaning and inspection' }
  }
}
