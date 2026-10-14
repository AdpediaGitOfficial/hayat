import { createHash, randomUUID } from 'node:crypto'
import { and, asc, eq } from 'drizzle-orm'
import { attachment } from '@/server/db/schema.stage3'
import type { Db } from '@/server/db/client'
import type { RequestContext } from '@/server/command/context'
import { runCommand } from '@/server/command/run'
import { fail, ok, type Result } from '@/server/command/result'
import { audit } from '@/server/audit'
import { getConfig } from '@/server/config/registry'
import { getStore } from './store'
import { safeFilename, sniff, type AttachmentType } from './sniff'
import { attachmentTarget } from './targets'
import './targets.index'

export interface AttachInput { entityType: string; entityId: string; filename: string; /** declared; checked against the bytes */ contentType?: string; dataBase64: string }
export interface AttachmentView { id: string; entityType: string; entityId: string; filename: string; contentType: AttachmentType; sizeBytes: number; sha256: string; uploadedBy: string; createdAt: Date }

export class FileDownload {
  constructor(readonly bytes: Buffer, readonly filename: string, readonly contentType: string) {}
}

const view = (a: typeof attachment.$inferSelect): AttachmentView => ({
  id: a.id, entityType: a.entityType, entityId: a.entityId, filename: a.filename, contentType: a.contentType, sizeBytes: a.sizeBytes, sha256: a.sha256, uploadedBy: a.uploadedBy, createdAt: a.createdAt,
})

export function attach(rc: RequestContext, i: AttachInput): Promise<Result<AttachmentView>> {
  return runCommand(rc, async c => {
    const target = attachmentTarget(i.entityType)
    if (!target) return fail.invalid('This kind of record cannot have attachments', { entityType: 'Unknown record type' })
    const rec = await target.load(c.tx, i.entityId)
    if (!rec) return fail.notFound()
    if (!target.canView(c.actor, rec)) return fail.notFound()            // not visible = not found
    if (!target.canAttach(c.actor, rec)) return fail.forbidden('attach files here')

    const maxBytes = (await getConfig(c.tx, 'attachments.max_mb')) * 1024 * 1024
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(i.dataBase64) || i.dataBase64.length > Math.ceil(maxBytes * 4 / 3) + 8) {
      return fail.invalid(`The file is too large or not valid (limit ${Math.round(maxBytes / 1024 / 1024)} MB)`, { dataBase64: 'Too large or not valid' })
    }
    const bytes = Buffer.from(i.dataBase64, 'base64')
    if (bytes.length === 0 || bytes.length > maxBytes) return fail.invalid(`The file is empty or larger than ${Math.round(maxBytes / 1024 / 1024)} MB`, { dataBase64: 'Wrong size' })
    const type = sniff(bytes)
    if (!type) return fail.invalid('Only PNG, JPEG and PDF files are accepted', { dataBase64: 'Not a PNG, JPEG or PDF' })
    if (i.contentType && i.contentType !== type) return fail.invalid('The file is not what it says it is', { contentType: `The content is ${type}` })

    const storageKey = `${new Date(c.now).getUTCFullYear()}/${randomUUID()}`
    await getStore().put(storageKey, bytes) // an orphan file after a rollback is harmless: keys are unique, nothing points at it
    const [row] = await c.tx.insert(attachment).values({
      entityType: i.entityType, entityId: i.entityId, siteId: rec.siteId ?? null, filename: safeFilename(i.filename, type), contentType: type,
      sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), storageKey, uploadedBy: c.user.id,
    }).returning()
    await audit(c, { action: 'attachment.added', entityType: i.entityType, entityId: i.entityId, siteId: rec.siteId, after: { attachmentId: row.id, filename: row.filename, sizeBytes: row.sizeBytes, sha256: row.sha256 } })
    return ok(view(row))
  })
}

/** Attachments of a record the actor may see; none (not an error) when the record is not theirs to see. */
export async function listAttachments(db: Pick<Db, 'select'>, actor: RequestContext['actor'], entityType: string, entityId: string): Promise<AttachmentView[]> {
  const target = attachmentTarget(entityType)
  if (!target) return []
  const rec = await target.load(db, entityId)
  if (!rec || !target.canView(actor, rec)) return []
  return (await db.select().from(attachment).where(and(eq(attachment.entityType, entityType), eq(attachment.entityId, entityId))).orderBy(asc(attachment.createdAt))).map(view)
}

export async function downloadAttachment(db: Pick<Db, 'select'>, actor: RequestContext['actor'], id: string): Promise<FileDownload | undefined> {
  const [a] = await db.select().from(attachment).where(eq(attachment.id, id)).limit(1)
  if (!a) return undefined
  const target = attachmentTarget(a.entityType)
  const rec = target ? await target.load(db, a.entityId) : undefined
  if (!target || !rec || !target.canView(actor, rec)) return undefined
  return new FileDownload(await getStore().get(a.storageKey), a.filename, a.contentType)
}

export { attachmentTarget }
