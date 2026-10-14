import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

/** Where the bytes live. The database row is the record; swapping this for object storage changes nothing else. */
export interface AttachmentStore {
  put(key: string, bytes: Buffer): Promise<void>
  get(key: string): Promise<Buffer>
}

const KEY = /^[0-9]{4}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export class LocalStore implements AttachmentStore {
  constructor(private readonly dir: string) {}
  private resolve(key: string): string {
    if (!KEY.test(key)) throw new Error('invalid storage key')   // never a path from user input
    return path.join(this.dir, key)
  }
  async put(key: string, bytes: Buffer): Promise<void> {
    const file = this.resolve(key)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, bytes, { flag: 'wx', mode: 0o600 })   // wx: never overwrite
  }
  async get(key: string): Promise<Buffer> { return readFile(this.resolve(key)) }
}

let current: AttachmentStore | undefined
export function getStore(): AttachmentStore {
  return (current ??= new LocalStore(path.resolve(process.env.ATTACHMENT_DIR ?? './data/attachments')))
}
export function setStore(s: AttachmentStore | undefined): void { current = s }
