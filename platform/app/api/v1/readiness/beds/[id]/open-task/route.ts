import { route } from '@/server/http'
import { fail } from '@/server/command/result'
import { manualInput, openCleaningTaskManual } from '@/server/commands/readiness/manual'
import { idParam } from '@/server/queries/property/respond'

export const dynamic = 'force-dynamic'

/**
 * Reception or the Super Admin opens a cleaning task BY HAND for a bed in Needs cleaning or Inspection required that has none (migrated or
 * seeded data). S-22, P-14: proposed, pending client sign-off. A reason is required and the action is audited; for a bed waiting for its final
 * inspection the task is created already cleaned, with a note that there is no cleaning record, so the inspection can proceed.
 */
export const POST = route({
  name: 'readiness.bed.open_task',
  access: { kind: 'action', action: 'housekeeping_readiness.assign' },
  body: manualInput.omit({ bedId: true }),
  handler: (rc, body, _req, _r, { params }) => {
    const bedId = idParam(params)
    return bedId ? openCleaningTaskManual(rc, { ...body, bedId }) : Promise.resolve(fail.notFound())
  },
})
