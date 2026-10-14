import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { admin, call, closeAll, makeUser, signIn } from '../harness'
import { JPEG, mkProperty, mkStaff, PDF, PNG } from '../fixtures3'
import { LocalStore, registerAttachmentTarget, setStore } from '@/server/attachments'
import { sniff, safeFilename } from '@/server/attachments/sniff'
import { POST as upload, GET as list } from '../../../app/api/v1/attachments/route'
import { GET as download } from '../../../app/api/v1/attachments/[id]/route'
import { eq, sql } from 'drizzle-orm'
import { room } from '@/server/db/schema'

afterAll(closeAll)

// A throwaway entity type, so the core is tested without any package: attaches to a ROOM, visible to those who see its site.
registerAttachmentTarget({
  entityType: 'test_room',
  async load(db, id) { const [r] = await db.select({ siteId: room.siteId }).from(room).where(eq(room.id, id)).limit(1); return r },
  canAttach: (a, rec) => a.role === 'AA' && (a.sites === 'all' || a.sites.includes(rec.siteId!)),
  canView: (a, rec) => ['AA', 'Rec'].includes(a.role) && (a.sites === 'all' || a.sites.includes(rec.siteId!)),
})

beforeAll(async () => { setStore(new LocalStore(await mkdtemp(path.join(tmpdir(), 'gh-att-')))) })

const b64 = (b: Buffer) => b.toString('base64')
async function world() {
  const p = await mkProperty({ beds: 1 })
  const other = await mkProperty({ beds: 1 })
  const aa = await makeUser({ roles: [{ role: 'AA', siteId: p.siteId }] })
  const rec = await makeUser({ roles: [{ role: 'Rec', siteId: p.siteId }] })
  const aaOther = await makeUser({ roles: [{ role: 'AA', siteId: other.siteId }] })
  const res = await makeUser({ roles: [{ role: 'Res' }] })
  return { p, aa: await signIn(aa), rec: await signIn(rec), aaOther: await signIn(aaOther), res: await signIn(res) }
}
const body = (roomId: string, data: Buffer, extra: object = {}) => ({ entityType: 'test_room', entityId: roomId, filename: 'evidence.png', dataBase64: b64(data), ...extra })

describe('sniffing', () => {
  it('knows PNG, JPEG and PDF by content, nothing else', () => {
    expect(sniff(PNG)).toBe('image/png'); expect(sniff(JPEG)).toBe('image/jpeg'); expect(sniff(PDF)).toBe('application/pdf')
    expect(sniff(Buffer.from('<html><script>alert(1)</script>'))).toBeUndefined()
    expect(sniff(Buffer.from('MZ\x90\x00'))).toBeUndefined()
    expect(sniff(Buffer.alloc(0))).toBeUndefined()
  })
  it('filenames carry no path, no control characters, and the right extension', () => {
    expect(safeFilename('../../etc/passwd', 'image/png')).toBe('passwd.png')
    expect(safeFilename('C:\\x\\evil.exe', 'application/pdf')).toBe('evil.pdf')
    expect(safeFilename('a"b\r\nc.jpg', 'image/jpeg')).toBe('a_b__c.jpg')
    expect(safeFilename('...', 'image/png')).toBe('attachment.png')
  })
})

describe('upload and download', () => {
  it('stores the file, records its hash, audits it, and the same bytes come back as a download', async () => {
    const w = await world()
    const up = await call(upload, { cookie: w.aa, body: body(w.p.roomId, PNG) })
    expect(up.status, JSON.stringify(up.body)).toBe(200)
    expect(up.body.data).toMatchObject({ filename: 'evidence.png', contentType: 'image/png', sizeBytes: PNG.length })
    expect(up.body.data.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect((await admin().query(`SELECT 1 FROM audit_event WHERE action = 'attachment.added' AND entity_id = $1`, [w.p.roomId])).rowCount).toBe(1)
    const dl = await download(new Request('http://localhost:3000/x', { headers: { host: 'localhost:3000', origin: 'http://localhost:3000', cookie: w.rec } }), { params: { id: up.body.data.id } })
    expect(dl.status).toBe(200)
    expect(dl.headers.get('content-type')).toBe('image/png')
    expect(dl.headers.get('x-content-type-options')).toBe('nosniff')
    expect(dl.headers.get('content-disposition')).toMatch(/^attachment; filename="evidence\.png"/)
    expect(Buffer.from(await dl.arrayBuffer()).equals(PNG)).toBe(true)
  })

  it('refuses what is not a PNG, JPEG or PDF, however it is labelled, and a label that lies', async () => {
    const w = await world()
    const html = await call(upload, { cookie: w.aa, body: body(w.p.roomId, Buffer.from('<html>hi</html>'), { contentType: 'image/png' }) })
    expect(html.status).toBe(422)
    const lie = await call(upload, { cookie: w.aa, body: body(w.p.roomId, PDF, { contentType: 'image/png' }) })
    expect(lie.status).toBe(422)
    expect(lie.body.fields.contentType).toMatch(/application\/pdf/)
    expect((await call(upload, { cookie: w.aa, body: body(w.p.roomId, PDF, { filename: 'plan.exe' }) })).body.data.filename).toBe('plan.pdf')
  })

  it('enforces the size limit and valid base64', async () => {
    const w = await world()
    const big = Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024 + 1)])
    expect((await call(upload, { cookie: w.aa, body: body(w.p.roomId, big) })).status).toBe(422)
    expect((await call(upload, { cookie: w.aa, body: { ...body(w.p.roomId, PNG), dataBase64: 'not base64 !!!!' } })).status).toBe(422)
  })

  it('permission of the record decides: out of scope reads as not found, a viewer who may not attach gets 403, a resident gets nothing', async () => {
    const w = await world()
    expect((await call(upload, { cookie: w.aaOther, body: body(w.p.roomId, PNG) })).status).toBe(404)
    expect((await call(upload, { cookie: w.rec, body: body(w.p.roomId, PNG) })).status).toBe(403)
    expect((await call(upload, { cookie: w.res, body: body(w.p.roomId, PNG) })).status).toBe(404)
    const up = await call(upload, { cookie: w.aa, body: body(w.p.roomId, PNG) })
    const id = up.body.data.id
    const asOther = await call(download, { cookie: w.aaOther, params: { id } })
    expect(asOther.status).toBe(404)
    expect((await call(download, { cookie: w.res, params: { id } })).status).toBe(404)
    expect((await call(list, { cookie: w.aaOther, path: `/api/v1/attachments?entityType=test_room&entityId=${w.p.roomId}` })).body.data).toEqual([])
    expect((await call(list, { cookie: w.rec, path: `/api/v1/attachments?entityType=test_room&entityId=${w.p.roomId}` })).body.data).toHaveLength(1)
  })

  it('an unknown record type, an unknown record and a malformed id are refused cleanly', async () => {
    const w = await world()
    expect((await call(upload, { cookie: w.aa, body: { ...body(w.p.roomId, PNG), entityType: 'nope' } })).status).toBe(422)
    expect((await call(upload, { cookie: w.aa, body: body('00000000-0000-4000-8000-000000000000', PNG) })).status).toBe(404)
    expect((await call(download, { cookie: w.aa, params: { id: 'not-a-uuid' } })).status).toBe(404)
  })

  it('attachments cannot be changed or deleted, not even by the database owner path used by the app', async () => {
    const w = await world()
    const up = await call(upload, { cookie: w.aa, body: body(w.p.roomId, JPEG) })
    const id = up.body.data.id
    const { Pool } = await import('pg'); const { inject } = await import('vitest')
    const app = new Pool({ connectionString: inject('appDbUrl') })
    try {
      await expect(app.query(`UPDATE attachment SET filename = 'x.png' WHERE id = $1`, [id])).rejects.toThrow(/permission denied/)
      await expect(app.query(`DELETE FROM attachment WHERE id = $1`, [id])).rejects.toThrow(/permission denied/)
    } finally { await app.end() }
    void mkStaff; void sql
  })
})
