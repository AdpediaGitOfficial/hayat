import type { RequestContext } from '@/server/command/context'
import type { Result } from '@/server/command/result'
import { archiveStructure, structureInput, type ArchiveOut, type ArchiveStructureInput } from './archive'

export const input = structureInput
export type ArchiveRoomInput = ArchiveStructureInput

/** Archive a room (Accommodation Admin or Super Admin). Refused with the dependencies listed while it is occupied, reserved or still has active beds (AT-029). */
export function archiveRoom(rc: RequestContext, i: ArchiveRoomInput): Promise<Result<ArchiveOut>> {
  return archiveStructure(rc, 'room', i)
}
