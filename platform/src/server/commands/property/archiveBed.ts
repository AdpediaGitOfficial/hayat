import type { RequestContext } from '@/server/command/context'
import type { Result } from '@/server/command/result'
import { archiveStructure, bedInput, type ArchiveBedInput, type ArchiveOut } from './archive'

export const input = bedInput
export type { ArchiveBedInput }

/** Archive one bed (Accommodation Admin or Super Admin, inside their sites). Refused with the dependencies listed (AT-029). */
export function archiveBed(rc: RequestContext, i: ArchiveBedInput): Promise<Result<ArchiveOut>> {
  return archiveStructure(rc, 'bed', { ...i, cascade: false })
}
