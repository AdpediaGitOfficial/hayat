import type { RequestContext } from '@/server/command/context'
import type { Result } from '@/server/command/result'
import { archiveStructure, structureInput, type ArchiveOut, type ArchiveStructureInput } from './archive'

export const input = structureInput
export type ArchiveBuildingInput = ArchiveStructureInput

/** Archive a building. Super Admin only ("Sites & buildings: manage"). Refused with the dependencies listed (AT-029). */
export function archiveBuilding(rc: RequestContext, i: ArchiveBuildingInput): Promise<Result<ArchiveOut>> {
  return archiveStructure(rc, 'building', i)
}
